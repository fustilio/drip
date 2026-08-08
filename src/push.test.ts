import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { computePlan } from "./planner";
import type { Correspondence } from "./store";
import { addOverride, getCorrespondence, openStore, upsertCorrespondence } from "./store";
import { commit, git, gitOutput, makeBareRemote, makeTempRepo } from "./test-helpers";

function correspondence(contentHash: string): Correspondence {
  return {
    branch: "feature",
    sliceSignature: "sig",
    sliceBranch: "drip/feature/slice0",
    prNumber: 1,
    prUrl: "https://example.com/pull/1",
    contentHash,
    commitSha: "deadbeef",
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
mock.module("./github", () => ({ ghCreatePr, ghPrClose, ghPrComment, ghPrState: mock(() => "OPEN") }));

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

async function runPush(dryRun = false) {
  const { push } = await import("./push");
  using db = openStore(repoRoot);
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const results = await push({ git: backend, db, repoRoot, branch: "feature", baseBranch: "main", mergeBase, plan, dryRun });
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
