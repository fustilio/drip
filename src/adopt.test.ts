import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { checkAdoption, fetchAdoptedHead, listProjectionCorrespondence, recordAdoption } from "./adopt";
import { ShellGitBackend } from "./git-backend";
import type { PrRef } from "./github";
import { ManifestSchema, manifestSignature, resolveManifest, unitsFromManifest, type Manifest } from "./manifest";
import { computePlan } from "./planner";
import { getCorrespondence, openStore } from "./store";
import { commit, git, githubMock, gitOutput, makeBareRemote, makeTempRepo } from "./test-helpers";

// issue #11: adopting handcrafted PRs into a semantic projection manifest.
//
// GitHub is mocked (it's the one boundary real git can't stand in for — see
// docs/adr/0010), but the branches being adopted are real branches on a real
// local bare remote, and every tree comparison below runs real git plumbing.

const ghCreatePr = mock((_opts: unknown) => ({ number: 42, url: "https://example.com/pull/42" }));
const ghPrClose = mock((_repoRoot: string, _prNumber: number, _comment: string) => {});
const ghPrComment = mock((_repoRoot: string, _prNumber: number, _body: string) => {});
const ghPrSetBase = mock((_repoRoot: string, _prNumber: number, _base: string) => {});
mock.module("./github", () => githubMock({ ghCreatePr, ghPrClose, ghPrComment, ghPrSetBase }));

const reconcileComments = mock(async (_opts: unknown) => ({ unchanged: 0, orphaned: 0 }));
mock.module("./anchors", () => ({ reconcileComments }));

const backend = new ShellGitBackend();
let repoRoot: string;
let remoteRoot: string;
let cleanupRepo: () => void;
let cleanupRemote: () => void;
let db: Database;

// The fixture is the shape adoption exists for: two independent roots and two
// dependents, so a projection can have no prerequisites, exactly one, or two.
const HELPER_V2 = `export function shared(x: number) {\n  return x + 2;\n}\n`;
const A_TS = `import { shared } from "./helper";\n\nexport function featureA() {\n  return shared(1);\n}\n`;

beforeEach(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-adopt-"));
  ({ remoteRoot, cleanup: cleanupRemote } = makeBareRemote("drip-adopt-remote-"));
  git(["remote", "add", "origin", remoteRoot], repoRoot);

  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  writeFileSync(join(repoRoot, "helper2.ts"), `export function other(x: number) {\n  return x + 10;\n}\n`);
  commit(repoRoot, "init");

  // The mega branch: everything, in one unreviewable lump.
  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2);
  writeFileSync(join(repoRoot, "helper2.ts"), `export function other(x: number) {\n  return x + 20;\n}\n`);
  writeFileSync(join(repoRoot, "a.ts"), A_TS);
  writeFileSync(
    join(repoRoot, "c.ts"),
    `import { shared } from "./helper";\nimport { other } from "./helper2";\n\nexport function featureC() {\n  return shared(1) + other(2);\n}\n`,
  );
  commit(repoRoot, "feature");

  db = openStore(repoRoot);
  ghCreatePr.mockClear();
  ghPrClose.mockClear();
  ghPrComment.mockClear();
  ghPrSetBase.mockClear();
  reconcileComments.mockClear();
});

afterEach(() => {
  db.close();
  cleanupRepo();
  cleanupRemote();
});

// A handcrafted PR branch: cut from `from`, edited, pushed to the remote, and
// left there — exactly what a team has before drip shows up.
function handcraft(name: string, from: string, edit: () => void): void {
  git(["checkout", "-q", "-b", name, from], repoRoot);
  edit();
  commit(repoRoot, `handcrafted: ${name}`);
  git(["push", "-q", "origin", name], repoRoot);
  git(["checkout", "-q", "feature"], repoRoot);
}

const manifest = (): Manifest =>
  ManifestSchema.parse({
    version: 1,
    sourceBranch: "feature",
    projections: [
      { id: "helper", atomicSlices: ["helper.ts::shared"], verificationReason: "fixture" },
      { id: "other", atomicSlices: ["helper2.ts::other"], verificationReason: "fixture" },
      { id: "feature-a", atomicSlices: ["a.ts::featureA"], dependsOn: ["helper"], verificationReason: "fixture" },
      { id: "feature-c", atomicSlices: ["c.ts::featureC"], dependsOn: ["helper", "other"], verificationReason: "fixture" },
    ],
  });

async function context() {
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const resolved = resolveManifest(plan, manifest(), { branch: "feature" });
  return { plan, mergeBase, resolved };
}

const prRef = (over: Partial<PrRef> = {}): PrRef => ({
  number: 373,
  url: "https://example.com/pull/373",
  state: "OPEN",
  headRefName: "team/helper",
  baseRefName: "main",
  title: "port the shared helper",
  ...over,
});

async function adopt(projectionId: string, head: string, pr: Partial<PrRef> = {}) {
  const { plan, mergeBase, resolved } = await context();
  return checkAdoption({
    git: backend,
    db,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    mergeBase,
    plan,
    resolved,
    projectionId,
    head,
    headSha: fetchAdoptedHead(backend, repoRoot, "origin", head),
    pr: prRef({ headRefName: head, ...pr }),
  });
}

const codes = (c: { findings: { code: string }[] }) => c.findings.map((f) => f.code);

test("a handcrafted branch whose content is the projection's is adopted, keeping its own branch and PR", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  const check = await adopt("helper", "team/helper");
  expect(check.findings).toEqual([]);
  expect(check.ok).toBe(true);
  expect(check.baseAgrees).toBe(true); // no prerequisites, so the manifest implies `main` too
  expect(check.prerequisites).toEqual([]);

  recordAdoption(db, "feature", check);
  const stored = getCorrespondence(db, "feature", manifestSignature("helper"))!;
  expect(stored.sliceBranch).toBe("team/helper"); // not drip/feature/helper
  expect(stored.prNumber).toBe(373);
  expect(stored.adopted).toBe(true);
  // The human's head is what's recorded, so a later push leases against the
  // branch reviewers actually saw.
  expect(stored.commitSha).toBe(backend.revParse("origin/team/helper", repoRoot));
  expect(listProjectionCorrespondence(db, "feature").map((a) => [a.projectionId, a.adopted])).toEqual([["helper", true]]);
});

test("a branch with content the projection doesn't have is refused, with an interdiff", async () => {
  handcraft("team/helper", "main", () => {
    writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2);
    writeFileSync(join(repoRoot, "stowaway.ts"), `export const smuggled = true;\n`);
  });

  const check = await adopt("helper", "team/helper");
  expect(check.ok).toBe(false);
  expect(codes(check)).toContain("adopt-mismatch");
  expect(check.interdiff).toContain("stowaway.ts");
  expect(() => recordAdoption(db, "feature", check)).toThrow(/did not validate/);
  expect(getCorrespondence(db, "feature", manifestSignature("helper"))).toBeNull();
});

test("a branch missing its prerequisites is refused by name, not just as a diff", async () => {
  // The most common real shape: a handcrafted PR cut from main that carries
  // only its own change, while the manifest says it sits on top of `helper`.
  handcraft("team/a", "main", () => writeFileSync(join(repoRoot, "a.ts"), A_TS));

  const check = await adopt("feature-a", "team/a", { number: 374 });
  expect(check.ok).toBe(false);
  const mismatch = check.findings.find((f) => f.code === "adopt-mismatch")!;
  expect(mismatch.message).toContain("prerequisite closure");
  expect(mismatch.message).toContain("helper");
});

test("a stacked handcrafted PR adopts once its prerequisite has been adopted, and its base agrees", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  handcraft("team/a", "team/helper", () => writeFileSync(join(repoRoot, "a.ts"), A_TS));

  recordAdoption(db, "feature", await adopt("helper", "team/helper"));

  const check = await adopt("feature-a", "team/a", { number: 374, baseRefName: "team/helper" });
  expect(check.findings).toEqual([]);
  expect(check.prerequisites).toEqual(["helper"]);
  // The manifest's implied base is the *adopted* branch of the prerequisite,
  // not the drip/... name push would otherwise have minted.
  expect(check.manifestBase).toBe("team/helper");
  expect(check.baseAgrees).toBe(true);
  expect(check.ok).toBe(true);
});

test("a base that disagrees with the manifest graph warns and is recorded as it is, never retargeted", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  handcraft("team/a", "team/helper", () => writeFileSync(join(repoRoot, "a.ts"), A_TS));
  recordAdoption(db, "feature", await adopt("helper", "team/helper"));

  const check = await adopt("feature-a", "team/a", { number: 374, baseRefName: "main" });
  const warning = check.findings.find((f) => f.code === "base-disagreement")!;
  expect(warning.severity).toBe("warning");
  expect(warning.message).toContain("team/helper");
  expect(check.ok).toBe(true); // a disagreement is a report, not a refusal

  recordAdoption(db, "feature", check);
  expect(getCorrespondence(db, "feature", manifestSignature("feature-a"))!.baseRef).toBe("main");
  expect(ghPrSetBase).not.toHaveBeenCalled();
});

test("adoption is refused on a closed PR, a mis-named branch, or a PR already bound elsewhere", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  expect(codes(await adopt("helper", "team/helper", { state: "MERGED" }))).toContain("adopt-pr-state");
  expect(codes(await adopt("helper", "team/helper", { headRefName: "team/something-else" }))).toContain("adopt-head-mismatch");

  recordAdoption(db, "feature", await adopt("helper", "team/helper"));
  // Same branch, different projection: two projections force-pushing one
  // branch would each undo the other.
  const conflict = await adopt("other", "team/helper");
  expect(codes(conflict)).toContain("adopt-conflict");
  expect(conflict.ok).toBe(false);
});

// --- what adoption is for: push then treats the PR as this projection's own --

async function runManifestPush() {
  const { push } = await import("./push");
  const { plan, mergeBase, resolved } = await context();
  const results = await push({
    git: backend,
    db,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    mergeBase,
    plan,
    dryRun: false,
    projection: "flat-first",
    units: unitsFromManifest(resolved, "feature"),
  });
  return new Map(results.map((r) => [r.sliceLabel, r]));
}

test("after adoption, push updates the adopted PR instead of opening a parallel one", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  recordAdoption(db, "feature", await adopt("helper", "team/helper"));

  const first = await runManifestPush();
  // The adopted projection: its own branch, its own PR, and no push at all —
  // the branch already shows exactly this content.
  expect(first.get("helper")!.branchName).toBe("team/helper");
  expect(first.get("helper")!.status).toBe("unchanged");
  expect(first.get("helper")!.prUrl).toBe("https://example.com/pull/373");
  // The other three are drip's own, and a dependent's base is the *adopted*
  // branch name, not the drip/... one.
  expect(first.get("feature-a")!.branchName).toBe("drip/feature/feature-a");
  expect(first.get("feature-a")!.base).toBe("team/helper");
  expect(ghCreatePr).toHaveBeenCalledTimes(3);
  expect(gitOutput(["log", "--format=%s", "-1", "team/helper"], remoteRoot).trim()).toBe("handcrafted: team/helper");

  // Now the mega branch moves: the adopted PR gets the update, keeping its
  // number, its branch, and an interdiff comment.
  ghCreatePr.mockClear();
  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 5;\n}\n`);
  commit(repoRoot, "mega: helper again");

  const second = await runManifestPush();
  expect(second.get("helper")!.status).toBe("updated");
  expect(second.get("helper")!.branchName).toBe("team/helper");
  expect(ghCreatePr).not.toHaveBeenCalled();
  // The adopted PR gets its interdiff, measured from the human's head. (The
  // two dependents get one too — helper's change moved their trees — so this
  // asserts on #373 rather than on a call count.)
  const interdiff = ghPrComment.mock.calls.filter((c) => c[1] === 373);
  expect(interdiff).toHaveLength(1);
  expect(interdiff[0]![2]).toContain("x + 5");
  expect(ghPrSetBase).not.toHaveBeenCalled();
  expect(gitOutput(["show", "team/helper:helper.ts"], remoteRoot)).toContain("x + 5");
});

test("push refuses to force over an adopted branch that moved on the remote", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  recordAdoption(db, "feature", await adopt("helper", "team/helper"));

  // A reviewer pushes a fix onto the adopted branch after drip recorded it.
  git(["checkout", "-q", "team/helper"], repoRoot);
  writeFileSync(join(repoRoot, "REVIEW.md"), `addressed in review\n`);
  commit(repoRoot, "reviewer: address feedback");
  git(["push", "-q", "origin", "team/helper"], repoRoot);
  git(["checkout", "-q", "feature"], repoRoot);

  // ...and the mega branch changes, so push has something it wants to send.
  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 5;\n}\n`);
  commit(repoRoot, "mega: helper again");

  const results = await runManifestPush();
  expect(results.get("helper")!.status).toBe("blocked");
  // Named as adopted, and pointed at the one command that re-binds it — an
  // adopted branch has no --reclaim escape hatch (docs/adr/0028).
  expect(results.get("helper")!.note).toContain("the adopted branch is at");
  expect(results.get("helper")!.note).toContain("manifest adopt");
  expect(results.get("helper")!.note).not.toContain("--reclaim");
  // The reviewer's commit is still there.
  expect(gitOutput(["log", "--format=%s", "-1", "team/helper"], remoteRoot).trim()).toBe("reviewer: address feedback");
});

test("several independent handcrafted PRs adopt into one manifest", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  handcraft("team/other", "main", () => writeFileSync(join(repoRoot, "helper2.ts"), `export function other(x: number) {\n  return x + 20;\n}\n`));

  recordAdoption(db, "feature", await adopt("helper", "team/helper"));
  recordAdoption(db, "feature", await adopt("other", "team/other", { number: 375, baseRefName: "main" }));

  expect(listProjectionCorrespondence(db, "feature").map((a) => a.branch).sort()).toEqual(["team/helper", "team/other"]);
  const results = await runManifestPush();
  expect(results.get("helper")!.status).toBe("unchanged");
  expect(results.get("other")!.status).toBe("unchanged");
  expect(ghCreatePr).toHaveBeenCalledTimes(2); // only the two drip-owned projections
});
