import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { parseDiff } from "./planner";
import { describeSource, resolveDiffSource, worktreeTree } from "./source";
import { commit, git, gitOutput, makeTempRepo } from "./test-helpers";
import { verifyTreeHash } from "./verify";
import { loadPlan } from "./workflow";

// issue #12: planning uncommitted work.
//
// The point of this mode is to partition a change *before* the commits that
// would make it reviewable exist, so every test here has a dirty worktree and
// asserts on real git objects — no fake diff source.

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanup: () => void;

beforeEach(() => {
  ({ repoRoot, cleanup } = makeTempRepo("drip-worktree-"));
  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  writeFileSync(join(repoRoot, "committed.ts"), `export function committedWork() {\n  return 1;\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "committed.ts"), `export function committedWork() {\n  return 2;\n}\n`);
  commit(repoRoot, "feature: committed half");
});

afterEach(() => cleanup());

const plan = (worktree: boolean, branch?: string) => loadPlan({ git: backend, repoRoot, branch, baseBranch: "main", worktree });

// The three states the issue names, all at once: staged, unstaged, untracked.
function dirtyWorktree() {
  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 2;\n}\n`);
  git(["add", "helper.ts"], repoRoot); // staged

  writeFileSync(join(repoRoot, "committed.ts"), `export function committedWork() {\n  return 3;\n}\n`); // unstaged

  mkdirSync(join(repoRoot, "hooks"), { recursive: true });
  writeFileSync(join(repoRoot, "hooks", "useAuth.ts"), `export function useAuth() {\n  return null;\n}\n`); // untracked
}

test("staged, unstaged and untracked changes all reach the plan", async () => {
  dirtyWorktree();
  const { plan: worktreePlan, source } = await plan(true);
  const files = new Set(worktreePlan.hunks.map((h) => h.file));

  expect(files).toContain("helper.ts"); // staged
  expect(files).toContain("committed.ts"); // unstaged
  expect(files).toContain("hooks/useAuth.ts"); // untracked
  expect(source.kind).toBe("worktree");
  expect(source.label).toBe("feature"); // the checked-out branch names the plan
  expect(source.uncommitted.map((u) => u.path).sort()).toEqual(["committed.ts", "helper.ts", "hooks/useAuth.ts"]);
});

test("the same run without --worktree sees only committed history", async () => {
  dirtyWorktree();
  const { plan: branchPlan } = await plan(false, "feature");
  const files = new Set(branchPlan.hunks.map((h) => h.file));

  expect(files).toEqual(new Set(["committed.ts"]));
  // ...and it's the *committed* version of that file, not the working copy.
  expect(branchPlan.hunks.filter((h) => h.file === "committed.ts")[0]!.changedText).toContain("return 2");
});

test("the plan is base-relative: committed work on the branch is included alongside the uncommitted work", async () => {
  dirtyWorktree();
  const { plan: worktreePlan } = await plan(true);
  // committed.ts was changed on the branch *and* again in the worktree; the
  // hunk against the merge base carries the working-tree content. Slicing only
  // the uncommitted delta would produce slices that don't apply on main.
  const hunk = worktreePlan.hunks.find((h) => h.file === "committed.ts")!;
  expect(hunk.changedText).toContain("return 3");
  expect(hunk.changedText).not.toContain("return 2");
});

test("the slices reconstruct the working tree, so the invariant still means something", async () => {
  dirtyWorktree();
  const { plan: worktreePlan, mergeBase, source } = await plan(true);
  const result = await verifyTreeHash({
    git: backend,
    repoRoot,
    branch: source.label,
    sourceRef: source.ref,
    mergeBase,
    files: worktreePlan.files,
    order: worktreePlan.order!,
    slices: worktreePlan.slices,
  });
  expect(result.pass).toBe(true);
  expect(result.message).toContain(source.ref); // the synthetic tree, reconstructed exactly
});

test("planning the worktree stages nothing and leaves the index alone", async () => {
  dirtyWorktree();
  const before = gitOutput(["status", "--porcelain"], repoRoot);
  await plan(true);
  expect(gitOutput(["status", "--porcelain"], repoRoot)).toBe(before);
  // Specifically: the unstaged file is still unstaged and the untracked file
  // is still untracked, however many trees drip built in the meantime.
  expect(before).toContain(" M committed.ts");
  expect(before).toContain("?? hooks/");
});

test("a clean worktree says so instead of quietly planning committed history", async () => {
  const { source } = await plan(true);
  expect(source.uncommitted).toEqual([]);
  expect(describeSource(source)).toContain("clean");
  expect(describeSource(source)).toContain("committed history only");
});

test("ignored files stay out, and a mislabelled worktree plan is refused", async () => {
  writeFileSync(join(repoRoot, ".gitignore"), `secrets.env\n`);
  writeFileSync(join(repoRoot, "secrets.env"), `TOKEN=hunter2\n`);
  commit(repoRoot, "ignore secrets");
  writeFileSync(join(repoRoot, "secrets.env"), `TOKEN=changed\n`);

  const tree = worktreeTree(backend, repoRoot);
  expect(gitOutput(["ls-tree", "-r", "--name-only", tree], repoRoot)).not.toContain("secrets.env");

  // The label decides which overrides/manifest the plan belongs to, so naming
  // a branch that isn't the checked-out one is an error, not a relabel.
  expect(() => resolveDiffSource(backend, repoRoot, { branch: "some-other-branch", baseBranch: "main", worktree: true })).toThrow(
    /working tree, which is on 'feature'/,
  );
});

// --- reporting what drip can't slice (issue #12's "files excluded") ---------

test("diff sections drip cannot slice are reported rather than dropped", async () => {
  writeFileSync(join(repoRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
  writeFileSync(join(repoRoot, "empty.ts"), "");
  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 2;\n}\n`);

  const { plan: worktreePlan } = await plan(true);
  const byPath = new Map(worktreePlan.excluded.map((e) => [e.path, e.reason]));

  expect(byPath.get("logo.png")).toBe("binary");
  expect(byPath.get("empty.ts")).toBe("empty-file");
  // The sliceable change is unaffected — exclusions are a report, not a bail-out.
  expect(worktreePlan.hunks.some((h) => h.file === "helper.ts")).toBe(true);
  // And an excluded section really is absent from every slice, which is why it
  // has to be reported: the tree-hash invariant will fail on it.
  expect([...worktreePlan.slices.values()].flat().some((h) => h.file === "logo.png")).toBe(false);
});

test("the tree-hash failure an exclusion causes names the exclusion", async () => {
  writeFileSync(join(repoRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02]));
  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 2;\n}\n`);

  const { plan: worktreePlan, mergeBase, source } = await plan(true);
  const args = {
    git: backend,
    repoRoot,
    branch: source.label,
    sourceRef: source.ref,
    mergeBase,
    files: worktreePlan.files,
    order: worktreePlan.order!,
    slices: worktreePlan.slices,
  };

  const explained = await verifyTreeHash({ ...args, excluded: worktreePlan.excluded });
  expect(explained.pass).toBe(false);
  expect(explained.message).toContain("logo.png (binary)");
  // Without the exclusions the same failure is a bare hash mismatch — which is
  // the state that made this class of bug hard to diagnose.
  expect((await verifyTreeHash(args)).message).not.toContain("logo.png");
});

test("a rename with no content change is reported by path, not silently lost", () => {
  const { files, excluded } = parseDiff(
    [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n"),
  );
  expect(files).toEqual([]);
  expect(excluded).toEqual([{ path: "old.ts", reason: "rename-only", detail: "similarity index 100% / rename from old.ts / rename to new.ts" }]);
});
