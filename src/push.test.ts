import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { computePlan } from "./planner";
import type { Correspondence } from "./store";
import { addOverride, getCorrespondence, openStore, upsertCorrespondence } from "./store";
import { commit, git, githubMock, gitOutput, makeBareRemote, makeTempRepo } from "./test-helpers";

function correspondence(contentHash: string): Correspondence {
  return {
    branch: "feature",
    sliceSignature: "sig",
    sliceBranch: "drip/feature/slice0",
    prNumber: 1,
    prUrl: "https://example.com/pull/1",
    contentHash,
    commitSha: "deadbeef",
    baseRef: "main",
    adopted: false,
  };
}

test("no correspondence, real mode -> created", async () => {
  const { classifySliceStatus } = await import("./push");
  expect(classifySliceStatus({ existing: null, squashMerged: false, contentHash: "abc", dryRun: false })).toBe("created");
});

test("no correspondence, dry-run -> dry-run (not created, since nothing's pushed yet)", async () => {
  const { classifySliceStatus } = await import("./push");
  expect(classifySliceStatus({ existing: null, squashMerged: false, contentHash: "abc", dryRun: true })).toBe("dry-run");
});

test("existing correspondence, content changed, real mode -> updated", async () => {
  const { classifySliceStatus } = await import("./push");
  expect(classifySliceStatus({ existing: correspondence("old"), squashMerged: false, contentHash: "new", dryRun: false })).toBe("updated");
});

test("existing correspondence, content changed, dry-run -> dry-run", async () => {
  const { classifySliceStatus } = await import("./push");
  expect(classifySliceStatus({ existing: correspondence("old"), squashMerged: false, contentHash: "new", dryRun: true })).toBe("dry-run");
});

test("existing correspondence, content unchanged -> unchanged, regardless of dry-run", async () => {
  const { classifySliceStatus } = await import("./push");
  expect(classifySliceStatus({ existing: correspondence("same"), squashMerged: false, contentHash: "same", dryRun: false })).toBe("unchanged");
  expect(classifySliceStatus({ existing: correspondence("same"), squashMerged: false, contentHash: "same", dryRun: true })).toBe("unchanged");
});

test("squash-merged wins over everything else, regardless of correspondence state or dry-run", async () => {
  const { classifySliceStatus } = await import("./push");
  expect(classifySliceStatus({ existing: null, squashMerged: true, contentHash: "abc", dryRun: false })).toBe("squash-merged");
  expect(classifySliceStatus({ existing: correspondence("same"), squashMerged: true, contentHash: "same", dryRun: false })).toBe("squash-merged");
  expect(classifySliceStatus({ existing: correspondence("old"), squashMerged: true, contentHash: "new", dryRun: true })).toBe("squash-merged");
});

// --- Wiring: does push()'s loop actually call the right side effects for
// each status? Real git throughout (a local bare repo as "origin" -- a real
// `git push`, no network) and github.ts/anchors.ts mocked, since GitHub's API
// is the one boundary that genuinely can't be exercised in a unit test.
// See docs/adr/0010-test-against-real-git.md.

const ghCreatePr = mock((_opts: unknown) => ({ number: 42, url: "https://example.com/pull/42" }));
const ghPrClose = mock((_repoRoot: string, _prNumber: number, _comment: string) => {});
const ghPrComment = mock((_repoRoot: string, _prNumber: number, _body: string) => {});
const ghPrSetBase = mock((_repoRoot: string, _prNumber: number, _base: string) => {});
mock.module("./github", () => githubMock({ ghCreatePr, ghPrClose, ghPrComment, ghPrSetBase }));

const reconcileComments = mock(async (_opts: unknown) => ({ unchanged: 0, orphaned: 0 }));
mock.module("./anchors", () => ({ reconcileComments }));

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanupRepo: () => void;
let remoteRoot: string;
let cleanupRemote: () => void;

beforeEach(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-push-test-"));
  ({ remoteRoot, cleanup: cleanupRemote } = makeBareRemote("drip-push-test-remote-"));
  git(["remote", "add", "origin", remoteRoot], repoRoot);

  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 1;\n}\n`);
  commit(repoRoot, "init");
  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 2;\n}\n`);
  commit(repoRoot, "feature");

  ghCreatePr.mockClear();
  ghPrClose.mockClear();
  ghPrComment.mockClear();
  reconcileComments.mockClear();
});

afterEach(() => {
  cleanupRepo();
  cleanupRemote();
});

async function runPush(dryRun = false, draft = false, extra: { reclaim?: boolean } = {}) {
  const { push } = await import("./push");
  using db = openStore(repoRoot);
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const results = await push({ git: backend, db, repoRoot, branch: "feature", baseBranch: "main", mergeBase, plan, dryRun, draft, ...extra });
  return { results, db, plan };
}

test("created: pushes the branch and opens a PR, closes nothing", async () => {
  const { results } = await runPush();
  expect(results).toHaveLength(1);
  expect(results[0]!.status).toBe("created");
  expect(ghCreatePr).toHaveBeenCalledTimes(1);
  expect(ghPrClose).not.toHaveBeenCalled();
  // Sanity: this was a real push to a real (local, bare) remote, not mocked.
  expect(gitOutput(["branch"], remoteRoot)).toContain("drip/feature/slice0");
});

test("unchanged: re-running with no changes calls neither git push nor any gh function", async () => {
  await runPush(); // first run: creates
  ghCreatePr.mockClear();
  const { results } = await runPush(); // second run: identical content
  expect(results[0]!.status).toBe("unchanged");
  expect(ghCreatePr).not.toHaveBeenCalled();
  expect(ghPrClose).not.toHaveBeenCalled();
  expect(ghPrComment).not.toHaveBeenCalled();
});

test("updated: content change on an existing PR posts an interdiff and reconciles comments, doesn't call ghCreatePr again", async () => {
  await runPush(); // first run: creates
  ghCreatePr.mockClear();

  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 3;\n}\n`);
  commit(repoRoot, "feature edit");

  const { results } = await runPush();
  expect(results[0]!.status).toBe("updated");
  expect(ghCreatePr).not.toHaveBeenCalled();
  expect(ghPrComment).toHaveBeenCalledTimes(1);
  expect(reconcileComments).toHaveBeenCalledTimes(1);
});

// --- issue #13: draft PRs ----------------------------------------------------

test("draft: a PR drip opens is created as a draft, and the result says so", async () => {
  const { results } = await runPush(false, true);
  expect(results[0]!.status).toBe("created");
  expect(results[0]!.draft).toBe(true);
  expect(ghCreatePr.mock.calls[0]![0]).toMatchObject({ draft: true });
});

test("draft: off by default — a PR is opened ready for review", async () => {
  const { results } = await runPush();
  expect(results[0]!.draft).toBe(false);
  expect(ghCreatePr.mock.calls[0]![0]).toMatchObject({ draft: false });
});

test("draft: dry-run reports the state it would open with, without opening anything", async () => {
  const { results } = await runPush(true, true);
  expect(results[0]!.status).toBe("dry-run");
  expect(results[0]!.draft).toBe(true);
  expect(ghCreatePr).not.toHaveBeenCalled();
});

test("draft: an existing PR keeps its own state — nothing is set, and the flag says why", async () => {
  await runPush(); // opens #42 ready for review
  ghCreatePr.mockClear();

  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 3;\n}\n`);
  commit(repoRoot, "feature edit");

  const { results } = await runPush(false, true);
  expect(results[0]!.status).toBe("updated");
  // No second create, so no draft state was set: the PR is what it already is.
  expect(ghCreatePr).not.toHaveBeenCalled();
  expect(results[0]!.draft).toBeNull();
  expect(results[0]!.note).toContain("--draft applies only when opening a PR");
});

// --- docs/adr/0028: a drip-owned branch that moved on the remote -------------
//
// The hole these cover: `unchanged` used to be decided purely against the sha
// drip recorded, so a commit someone pushed onto a drip-owned branch was either
// force-pushed away (plan moved) or left in place under an "unchanged" that
// claimed the PR was right (plan didn't). Neither was reported.

/** A reviewer pushes a commit straight onto the branch drip opened. */
function pushOntoSliceBranch(message: string) {
  git(["fetch", "-q", "origin", "drip/feature/slice0"], repoRoot);
  git(["checkout", "-q", "-B", "reviewer", "FETCH_HEAD"], repoRoot);
  writeFileSync(join(repoRoot, "REVIEW.md"), `${message}\n`);
  commit(repoRoot, message);
  git(["push", "-q", "origin", "reviewer:drip/feature/slice0"], repoRoot);
  git(["checkout", "-q", "feature"], repoRoot);
}

test("drip-owned branch moved, plan unchanged: blocked, not reported 'unchanged'", async () => {
  await runPush();
  pushOntoSliceBranch("reviewer: address feedback");

  const { results } = await runPush();
  expect(results[0]!.status).toBe("blocked");
  expect(results[0]!.note).toContain("someone pushed to it");
  expect(results[0]!.note).toContain("--reclaim");
  // The commit is still there: refusing means refusing, not "warn and clobber".
  expect(gitOutput(["log", "--format=%s", "-1", "drip/feature/slice0"], remoteRoot).trim()).toBe("reviewer: address feedback");
});

test("drip-owned branch moved, plan also moved: still blocked rather than force-pushed over", async () => {
  await runPush();
  pushOntoSliceBranch("reviewer: address feedback");

  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 3;\n}\n`);
  commit(repoRoot, "feature edit");

  const { results } = await runPush();
  expect(results[0]!.status).toBe("blocked");
  expect(gitOutput(["log", "--format=%s", "-1", "drip/feature/slice0"], remoteRoot).trim()).toBe("reviewer: address feedback");
  // Blocked means nothing was sent to GitHub either.
  expect(ghPrComment).not.toHaveBeenCalled();
  expect(reconcileComments).not.toHaveBeenCalled();
});

test("--reclaim overwrites a drip-owned branch that moved, and says it did", async () => {
  await runPush();
  pushOntoSliceBranch("reviewer: address feedback");

  const { results } = await runPush(false, false, { reclaim: true });
  expect(results[0]!.status).toBe("updated");
  expect(results[0]!.note).toContain("--reclaim overwrote it");
  expect(gitOutput(["log", "--format=%s", "-1", "drip/feature/slice0"], remoteRoot).trim()).not.toBe("reviewer: address feedback");
});

test("--reclaim is not an adopted-branch escape hatch: it only touches branches drip owns", async () => {
  const { push } = await import("./push");
  using db = openStore(repoRoot);
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const { computeSliceSignature } = await import("./signature");
  const signature = computeSliceSignature(plan.slices.get(plan.order![0]!)!);

  // Same drift, but the correspondence says this branch was adopted.
  await push({ git: backend, db, repoRoot, branch: "feature", baseBranch: "main", mergeBase, plan, dryRun: false });
  upsertCorrespondence(db, { ...getCorrespondence(db, "feature", signature)!, adopted: true });
  pushOntoSliceBranch("reviewer: address feedback");

  const results = await push({ git: backend, db, repoRoot, branch: "feature", baseBranch: "main", mergeBase, plan, dryRun: false, reclaim: true });
  expect(results[0]!.status).toBe("blocked");
  expect(results[0]!.note).toContain("manifest adopt");
  expect(gitOutput(["log", "--format=%s", "-1", "drip/feature/slice0"], remoteRoot).trim()).toBe("reviewer: address feedback");
});

test("a drip-owned branch deleted from the remote is recreated, not reported 'unchanged'", async () => {
  await runPush();
  git(["push", "-q", "origin", "--delete", "drip/feature/slice0"], repoRoot);

  const { results } = await runPush();
  expect(results[0]!.status).toBe("updated");
  expect(results[0]!.note).toContain("recreated");
  expect(gitOutput(["branch"], remoteRoot)).toContain("drip/feature/slice0");
});

test("dry-run reports drift without pushing anything", async () => {
  await runPush();
  pushOntoSliceBranch("reviewer: address feedback");

  const { results } = await runPush(true);
  expect(results[0]!.status).toBe("blocked");
  expect(gitOutput(["log", "--format=%s", "-1", "drip/feature/slice0"], remoteRoot).trim()).toBe("reviewer: address feedback");
});

// --- issue #6: flat-first projection ----------------------------------------
//
// Fixture DAG: `shared` and `other` are independent roots; featureA depends on
// `shared` alone; featureC depends on both.

function makeFlatFixture(opts: { withDependent?: boolean } = {}) {
  const { repoRoot: root, cleanup: cleanupRoot } = makeTempRepo("drip-push-flat-");
  const { remoteRoot: remote, cleanup: cleanupRemote } = makeBareRemote("drip-push-flat-remote-");
  git(["remote", "add", "origin", remote], root);

  writeFileSync(join(root, "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  writeFileSync(join(root, "helper2.ts"), `export function other(x: number) {\n  return x + 10;\n}\n`);
  commit(root, "init");

  git(["checkout", "-q", "-b", "feature"], root);
  writeFileSync(join(root, "helper.ts"), `export function shared(x: number) {\n  return x + 2;\n}\n`);
  writeFileSync(join(root, "helper2.ts"), `export function other(x: number) {\n  return x + 20;\n}\n`);
  writeFileSync(join(root, "a.ts"), `import { shared } from "./helper";\n\nexport function featureA() {\n  return shared(1);\n}\n`);
  writeFileSync(
    join(root, "c.ts"),
    `import { shared } from "./helper";\nimport { other } from "./helper2";\n\nexport function featureC() {\n  return shared(1) + other(2);\n}\n`,
  );
  // A slice whose only prerequisite is featureC — i.e. one that sits *above*
  // the projection with the integration base. Used to check that refusing to
  // push featureC refuses this too, rather than opening a PR against a branch
  // that was never pushed.
  if (opts.withDependent) {
    writeFileSync(join(root, "d.ts"), `import { featureC } from "./c";\n\nexport function featureD() {\n  return featureC() + 1;\n}\n`);
  }
  commit(root, "feature");

  return {
    root,
    remote,
    cleanup: () => {
      cleanupRoot();
      cleanupRemote();
    },
  };
}

async function runFlatPush(root: string, projection: "stacked" | "flat-first", opts: { reviewableStack?: boolean } = {}) {
  const { push } = await import("./push");
  using db = openStore(root);
  const plan = await computePlan({ git: backend, repoRoot: root, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", root);
  const results = await push({
    git: backend,
    db,
    repoRoot: root,
    branch: "feature",
    baseBranch: "main",
    mergeBase,
    plan,
    dryRun: false,
    projection,
    reviewableStack: opts.reviewableStack,
  });
  // Index results by a file the slice touches, so assertions don't depend on
  // slice numbering.
  const byFile = new Map<string, (typeof results)[number]>();
  for (const r of results) {
    const entry = [...plan.slices.entries()].find(([id]) => `slice${plan.idToNum.get(id)}` === r.sliceLabel)!;
    for (const file of new Set(entry[1].map((h) => h.file))) byFile.set(file, r);
  }
  return { results, byFile };
}

test("issue #6: flat-first targets independent roots at the base branch, not at each other", async () => {
  const { root, cleanup } = makeFlatFixture();
  try {
    const { results, byFile } = await runFlatPush(root, "flat-first");
    expect(results.every((r) => r.status === "created")).toBe(true);

    // Two independent roots: both go straight at main.
    expect(byFile.get("helper.ts")!.base).toBe("main");
    expect(byFile.get("helper2.ts")!.base).toBe("main");
    // One prerequisite: targets that prerequisite's branch, nothing else.
    expect(byFile.get("a.ts")!.base).toBe(byFile.get("helper.ts")!.branchName);
    // Two prerequisites: gets a generated integration base, and says so.
    expect(byFile.get("c.ts")!.base).toBe(`${byFile.get("c.ts")!.branchName}-base`);
    expect(byFile.get("c.ts")!.note).toContain("integration base unions");

    // No PR is stacked on another purely because of topological ordering.
    expect(byFile.get("helper2.ts")!.base).not.toBe(byFile.get("helper.ts")!.branchName);
  } finally {
    cleanup();
  }
});

test("issue #6: a flat-first root branch contains only its own slice, unlike the stacked chain", async () => {
  const flat = makeFlatFixture();
  const stacked = makeFlatFixture();
  try {
    const { byFile: flatByFile } = await runFlatPush(flat.root, "flat-first");
    const { byFile: stackedByFile } = await runFlatPush(stacked.root, "stacked");

    // helper2 is independent of helper. Flat-first's helper2 branch must not
    // carry helper's change; the stacked chain (if helper2 comes later) does.
    const flatHelper2 = gitOutput(["show", `${flatByFile.get("helper2.ts")!.branchName}:helper.ts`], flat.remote);
    expect(flatHelper2).toContain("x + 1"); // unchanged — helper's slice isn't in this branch

    // Sanity that the fixture actually exercises the difference: in stacked
    // mode the later branch does carry the earlier slice.
    const stackedLast = [...stackedByFile.values()].sort((a, b) => a.sliceLabel.localeCompare(b.sliceLabel)).pop()!;
    expect(gitOutput(["show", `${stackedLast.branchName}:helper.ts`], stacked.remote)).toContain("x + 2");
  } finally {
    flat.cleanup();
    stacked.cleanup();
  }
});

test("issue #6: switching projection re-pushes the branch and re-targets the PR, not one without the other", async () => {
  const { root, remote, cleanup } = makeFlatFixture();
  try {
    await runFlatPush(root, "stacked");
    ghPrSetBase.mockClear();
    ghCreatePr.mockClear();
    const { byFile } = await runFlatPush(root, "flat-first");

    // The slice's own patch is untouched, but its branch content and target
    // both moved — so this is an update, not a no-op skip.
    const helper2 = byFile.get("helper2.ts")!;
    expect(helper2.status).toBe("updated");
    expect(helper2.base).toBe("main");
    expect(ghCreatePr).not.toHaveBeenCalled(); // correspondence preserved across the switch
    expect(ghPrSetBase.mock.calls.map((c) => c[2])).toContain("main");
    // The re-pushed branch really is the flat one now.
    expect(gitOutput(["show", `${helper2.branchName}:helper.ts`], remote)).toContain("x + 1");
  } finally {
    cleanup();
  }
});

test("re-running in the same projection is still a no-op: no re-push, no re-target", async () => {
  const { root, cleanup } = makeFlatFixture();
  try {
    await runFlatPush(root, "flat-first");
    ghPrSetBase.mockClear();
    ghCreatePr.mockClear();
    const { results } = await runFlatPush(root, "flat-first");
    expect(results.every((r) => r.status === "unchanged")).toBe(true);
    expect(ghPrSetBase).not.toHaveBeenCalled();
    expect(ghCreatePr).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

// --- issue #14: hidden integration bases -------------------------------------

test("a generated integration base is flagged as not reviewable on GitHub", async () => {
  const { root, cleanup } = makeFlatFixture();
  try {
    const { results, byFile } = await runFlatPush(root, "flat-first");
    const c = byFile.get("c.ts")!;
    // Two prerequisites, so drip mints a branch that has no PR of its own.
    expect(c.base).toBe(`${c.branchName}-base`);
    expect(c.hiddenBase).toBe(true);
    expect(c.note).toContain("not directly reviewable on GitHub");
    expect(c.note).toContain("won't run CI");
    // Everything targeting a real branch or the base branch is unaffected.
    expect(results.filter((r) => r.hiddenBase)).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("--reviewable-stack refuses the hidden base instead of pushing it", async () => {
  const { root, remote, cleanup } = makeFlatFixture();
  try {
    const { byFile } = await runFlatPush(root, "flat-first", { reviewableStack: true });
    const c = byFile.get("c.ts")!;
    expect(c.status).toBe("blocked");
    expect(c.hiddenBase).toBe(false);
    expect(c.note).toContain("--reviewable-stack");
    // Refused means refused: no branch, no integration branch, no PR.
    const remoteBranches = gitOutput(["branch"], remote);
    expect(remoteBranches).not.toContain(c.branchName);
    expect(remoteBranches).not.toContain(`${c.branchName}-base`);
    // The independent roots still go out — one unreviewable projection doesn't
    // hold back the ones that are fine.
    expect(byFile.get("helper.ts")!.status).toBe("created");
    expect(byFile.get("helper2.ts")!.status).toBe("created");
  } finally {
    cleanup();
  }
});

test("--reviewable-stack also refuses whatever depended on the refused projection", async () => {
  const { root, remote, cleanup } = makeFlatFixture({ withDependent: true });
  try {
    const { byFile } = await runFlatPush(root, "flat-first", { reviewableStack: true });
    const d = byFile.get("d.ts")!;
    // Its base would be featureC's branch, which was never pushed — a PR
    // against a nonexistent branch is not an improvement on no PR.
    expect(d.status).toBe("blocked");
    expect(d.note).toContain("was not pushed");
    expect(gitOutput(["branch"], remote)).not.toContain(d.branchName);
  } finally {
    cleanup();
  }
});

test("--reviewable-stack is a no-op in stacked mode, which has no generated bases", async () => {
  const { root, cleanup } = makeFlatFixture();
  try {
    const { results } = await runFlatPush(root, "stacked", { reviewableStack: true });
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(results.some((r) => r.hiddenBase)).toBe(false);
  } finally {
    cleanup();
  }
});

test("squash-merged: content already on main closes the existing PR, never pushes a branch", async () => {
  await runPush(); // first run: creates a correspondence with an open PR
  ghCreatePr.mockClear();

  // Simulate a squash-merge: replicate the same content change on main as a
  // sibling commit, NOT a merge -- a real squash-merge doesn't make main a
  // descendant of feature, so mergeBase(main, feature) must stay put.
  git(["checkout", "-q", "main"], repoRoot);
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 2;\n}\n`);
  commit(repoRoot, "squash: same content, landed independently on main");
  git(["checkout", "-q", "feature"], repoRoot);

  const { results } = await runPush();
  expect(results[0]!.status).toBe("squash-merged");
  expect(ghPrClose).toHaveBeenCalledTimes(1);
  expect(ghCreatePr).not.toHaveBeenCalled();
});
