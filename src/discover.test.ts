import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { checkAdoption, fetchAdoptedHead, recordAdoption } from "./adopt";
import { discoverAdoptionCandidates } from "./discover";
import { ShellGitBackend } from "./git-backend";
import type { PrRef, PrSummary } from "./github";
import { ManifestSchema, resolveManifest, type Manifest } from "./manifest";
import { computePlan } from "./planner";
import { openStore } from "./store";
import { commit, git, githubMock, gitOutput, makeBareRemote, makeTempRepo } from "./test-helpers";

// issue #17: finding which existing PRs a projection could be adopted into.
//
// `gh pr list` is the one thing mocked (the open-PR list is GitHub state and
// nothing else can stand in for it) — every branch below is a real branch on a
// real local bare remote, and every match is decided by real git plumbing on
// real trees, exactly as `manifest adopt` decides it.

const ghCreatePr = mock((_opts: unknown) => ({ number: 0, url: "" }));
const ghPrClose = mock(() => {});
const ghPrComment = mock(() => {});
const ghPrSetBase = mock(() => {});
mock.module("./github", () => githubMock({ ghCreatePr, ghPrClose, ghPrComment, ghPrSetBase }));

const backend = new ShellGitBackend();
let repoRoot: string;
let remoteRoot: string;
let cleanupRepo: () => void;
let cleanupRemote: () => void;
let db: Database;

const HELPER_V2 = `export function shared(x: number) {\n  return x + 2;\n}\n`;
const A_TS = `import { shared } from "./helper";\n\nexport function featureA() {\n  return shared(1);\n}\n`;

beforeEach(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-discover-"));
  ({ remoteRoot, cleanup: cleanupRemote } = makeBareRemote("drip-discover-remote-"));
  git(["remote", "add", "origin", remoteRoot], repoRoot);

  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  writeFileSync(join(repoRoot, "helper2.ts"), `export function other(x: number) {\n  return x + 10;\n}\n`);
  commit(repoRoot, "init");
  git(["push", "-q", "origin", "main"], repoRoot);

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2);
  writeFileSync(join(repoRoot, "helper2.ts"), `export function other(x: number) {\n  return x + 20;\n}\n`);
  writeFileSync(join(repoRoot, "a.ts"), A_TS);
  commit(repoRoot, "feature");

  db = openStore(repoRoot);
  ghCreatePr.mockClear();
  ghPrClose.mockClear();
  ghPrComment.mockClear();
  ghPrSetBase.mockClear();
});

afterEach(() => {
  db.close();
  cleanupRepo();
  cleanupRemote();
});

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
      { id: "helper", intent: "Bump the shared helper.", atomicSlices: ["helper.ts::shared"], verificationReason: "fixture" },
      { id: "other", intent: "Bump the other helper.", atomicSlices: ["helper2.ts::other"], verificationReason: "fixture" },
      { id: "feature-a", intent: "Add feature A.", atomicSlices: ["a.ts::featureA"], dependsOn: ["helper"], verificationReason: "fixture" },
    ],
  });

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 373,
  url: "https://example.com/pull/373",
  title: "port the shared helper",
  headRefName: "team/helper",
  baseRefName: "main",
  ...over,
});

async function discover(prs: PrSummary[]) {
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const resolved = resolveManifest(plan, manifest(), { branch: "feature" });
  return discoverAdoptionCandidates({
    git: backend,
    db,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    mergeBase,
    plan,
    resolved,
    remote: "origin",
    prs,
  });
}

test("a PR whose branch is exactly a projection's tree is offered, with the command to adopt it", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  const report = await discover([pr()]);
  expect(report.candidates.length).toBe(1);
  const candidate = report.candidates[0]!;
  expect(candidate.projectionId).toBe("helper");
  expect(candidate.evidence).toBe("exact-tree");
  // The exact invocation, with all three of projection, PR and head — the same
  // three `manifest adopt` re-checks before it binds anything.
  expect(candidate.command).toBe("drip manifest adopt feature --projection helper --pr 373 --head team/helper --yes");
  expect(report.unmatched.map((u) => u.projectionId).sort()).toEqual(["feature-a", "other"]);
});

test("discovery writes nothing: no correspondence, no remote refs, no gh calls beyond the PR list", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  const refsBefore = gitOutput(["for-each-ref", "--format=%(refname) %(objectname)"], remoteRoot);

  await discover([pr()]);

  expect(gitOutput(["for-each-ref", "--format=%(refname) %(objectname)"], remoteRoot)).toBe(refsBefore);
  // Nothing was bound — adoption stays a separate, explicit step.
  expect(db.query("SELECT COUNT(*) as n FROM correspondence").get()).toEqual({ n: 0 });
  for (const write of [ghCreatePr, ghPrClose, ghPrComment, ghPrSetBase]) expect(write).not.toHaveBeenCalled();
});

test("a branch carrying a projection's own change but not its prerequisites is named, not silently dropped", async () => {
  // The commonest real shape: a handcrafted PR cut from main that carries only
  // its own change, while the manifest says it sits on top of `helper`.
  handcraft("team/a", "main", () => writeFileSync(join(repoRoot, "a.ts"), A_TS));

  const report = await discover([pr({ number: 374, headRefName: "team/a", title: "feature A" })]);
  const candidate = report.candidates.find((c) => c.projectionId === "feature-a")!;
  expect(candidate.evidence).toBe("own-change-only");
  expect(candidate.note).toContain("prerequisite closure");
  expect(candidate.note).toContain("helper");
});

test("an unrelated open PR produces no candidate at all — titles and names are never evidence", async () => {
  // Named exactly like the projection, containing something else entirely.
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "unrelated.ts"), `export const nope = 1;\n`));

  const report = await discover([pr({ title: "helper: bump shared" })]);
  expect(report.candidates).toEqual([]);
  expect(report.unmatched.map((u) => u.projectionId).sort()).toEqual(["feature-a", "helper", "other"]);
  expect(report.unmatched.find((u) => u.projectionId === "helper")!.reason).toContain("nothing here is evidence enough");
});

test("a projection already bound is listed as bound rather than rediscovered", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const resolved = resolveManifest(plan, manifest(), { branch: "feature" });
  const prRef: PrRef = { number: 373, url: "https://example.com/pull/373", state: "OPEN", headRefName: "team/helper", baseRefName: "main", title: "t" };
  recordAdoption(
    db,
    "feature",
    await checkAdoption({
      git: backend,
      db,
      repoRoot,
      branch: "feature",
      baseBranch: "main",
      mergeBase,
      plan,
      resolved,
      projectionId: "helper",
      head: "team/helper",
      headSha: fetchAdoptedHead(backend, repoRoot, "origin", "team/helper"),
      pr: prRef,
    }),
  );

  const report = await discover([pr()]);
  expect(report.candidates).toEqual([]);
  expect(report.bound).toEqual([{ projectionId: "helper", head: "team/helper", prNumber: 373, adopted: true }]);
  // Its branch isn't re-examined either — it belongs to a projection already.
  expect(report.examined).toBe(0);
});

test("a PR whose branch can't be fetched is reported as skipped, and the rest still run", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  const report = await discover([pr({ number: 999, headRefName: "team/never-pushed" }), pr()]);
  expect(report.skipped.map((s) => s.head)).toEqual(["team/never-pushed"]);
  expect(report.skipped[0]!.reason).toContain("could not fetch");
  expect(report.candidates.map((c) => c.projectionId)).toEqual(["helper"]);
});

test("two open PRs carrying the same tree are both offered, with the ambiguity stated", async () => {
  handcraft("team/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));
  handcraft("other/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  const report = await discover([pr(), pr({ number: 380, headRefName: "other/helper", title: "same change, other author" })]);
  expect(report.candidates.length).toBe(2);
  expect(report.candidates.every((c) => c.projectionId === "helper" && c.evidence === "exact-tree")).toBe(true);
  // Indistinguishable by content is exactly what drip should say, rather than
  // picking the first and calling it a match.
  expect(report.candidates[0]!.note).toContain("indistinguishable by content");
});

test("drip's own branches are not offered as discoveries", async () => {
  handcraft("drip/feature/helper", "main", () => writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2));

  const report = await discover([pr({ headRefName: "drip/feature/helper" })]);
  expect(report.examined).toBe(0);
  expect(report.candidates).toEqual([]);
});
