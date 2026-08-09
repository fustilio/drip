import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { GitBackend } from "./git-backend";
import { buildSlicePatch, materializeSliceCommits } from "./materialize";
import type { FileSection, Hunk } from "./planner";
import { computeContentHash, computeSliceSignature } from "./signature";
import { getBuildCache, upsertBuildCache } from "./store";

export const DEFAULT_BUILD_CMD = "bunx tsc --noEmit";

export type TreeHashResult = { pass: boolean; message: string };
export type BuildCheckResult = { failures: Array<{ slice: string; output: string }>; skipped: number };

export async function verifyTreeHash(opts: {
  git: GitBackend;
  repoRoot: string;
  branch: string;
  mergeBase: string;
  files: FileSection[];
  order: string[];
  slices: Map<string, Hunk[]>;
}): Promise<TreeHashResult> {
  const { git, repoRoot, branch, mergeBase, files, order, slices } = opts;
  const expected = git.revParse(`${branch}^{tree}`, repoRoot);
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-verify-tree-"));
  const indexFile = join(tmpDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  try {
    git.readTree(mergeBase, repoRoot, env);
    for (const id of order) {
      const patch = buildSlicePatch(files, slices, id);
      if (!patch) continue;
      const patchFile = join(tmpDir, "patch.diff");
      writeFileSync(patchFile, patch);
      try {
        git.applyCached(patchFile, repoRoot, env);
      } catch (e) {
        return { pass: false, message: `INVARIANT: FAIL — could not apply ${id}\n${String(e)}` };
      }
    }
    const actual = git.writeTree(repoRoot, env);
    return actual === expected
      ? { pass: true, message: `INVARIANT: PASS (tree ${actual})` }
      : { pass: false, message: `INVARIANT: FAIL — expected ${expected}, got ${actual}` };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// A disposable checkout of one materialized commit, with the repo's
// node_modules linked in so commands can actually run. Shared by the per-slice
// build check and by manifest verification (src/verification.ts) — both need
// "run something against exactly this tree", and one of them having its own
// copy of the worktree/symlink/cleanup dance is how the two quietly diverge.
export function withWorktree<T>(opts: { git: GitBackend; repoRoot: string; worktreePath: string; commit: string }, fn: (dir: string) => T): T {
  const { git, repoRoot, worktreePath, commit } = opts;
  const nodeModulesSrc = join(repoRoot, "node_modules");
  git.worktreeAdd(worktreePath, commit, repoRoot);
  try {
    if (existsSync(nodeModulesSrc)) {
      // Junctions don't require elevated privileges on Windows; plain
      // symlinks do. Elsewhere a normal dir symlink is fine.
      symlinkSync(nodeModulesSrc, join(worktreePath, "node_modules"), platform() === "win32" ? "junction" : "dir");
    }
    return fn(worktreePath);
  } finally {
    git.worktreeRemove(worktreePath, repoRoot);
  }
}

function runSliceBuild(opts: {
  git: GitBackend;
  repoRoot: string;
  tmpDir: string;
  sliceLabel: string;
  sliceNum: number;
  commit: string;
  buildCmd: string;
}): { slice: string; output: string } | null {
  const { git, repoRoot, tmpDir, sliceLabel, sliceNum, commit, buildCmd } = opts;
  return withWorktree({ git, repoRoot, worktreePath: join(tmpDir, `wt-${sliceNum}`), commit }, (dir) => {
    try {
      execSync(buildCmd, { cwd: dir, stdio: "pipe" });
      return null;
    } catch (e: any) {
      const output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") || e.message;
      return { slice: sliceLabel, output };
    }
  });
}

export async function verifyPerSliceBuild(opts: {
  git: GitBackend;
  db: Database;
  branch: string;
  repoRoot: string;
  mergeBase: string;
  files: FileSection[];
  order: string[];
  slices: Map<string, Hunk[]>;
  idToNum: Map<string, number>;
  buildCmd: string;
  label?: (id: string) => string;
}): Promise<BuildCheckResult> {
  const { git, db, branch, files, order, slices, repoRoot, idToNum, buildCmd } = opts;
  const label = opts.label ?? ((id: string) => `slice${idToNum.get(id)}`);
  const commits = await materializeSliceCommits(opts);
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-verify-build-"));
  const failures: Array<{ slice: string; output: string }> = [];

  // M5: a slice's build result is reused from cache only while every slice
  // before it in the stack (inclusive) is also unchanged -- our materialized
  // commits form a single linear stack (docs/adr/0006), so a slice's build
  // genuinely depends on everything ahead of it, not just its DAG edges. See
  // docs/adr/0008-build-cache-scope.md for why this is prefix-based rather
  // than true graph-independence.
  let prefixUnchanged = true;
  const toBuild: Array<{ sliceLabel: string; sliceNum: number; commit: string; signature: string; contentHash: string }> = [];

  try {
    for (const { sliceId, commit } of commits) {
      const sliceLabel = label(sliceId);
      const sliceNum = idToNum.get(sliceId)!;
      const hunks = slices.get(sliceId)!;
      const signature = computeSliceSignature(hunks);
      const contentHash = computeContentHash(buildSlicePatch(files, slices, sliceId));
      const cached = getBuildCache(db, branch, signature);

      if (prefixUnchanged && cached && cached.contentHash === contentHash && cached.passed) {
        continue; // reuse: this slice, and everything before it, hasn't changed since it last passed
      }
      prefixUnchanged = false;
      toBuild.push({ sliceLabel, sliceNum, commit, signature, contentHash });
    }

    // Each slice's worktree is an independent filesystem checkout of an
    // already-materialized commit, so running the builds concurrently is
    // safe regardless of stack order.
    const results = await Promise.all(
      toBuild.map(async (s) => {
        const failure = runSliceBuild({ git, repoRoot, tmpDir, sliceLabel: s.sliceLabel, sliceNum: s.sliceNum, commit: s.commit, buildCmd });
        upsertBuildCache(db, branch, s.signature, { contentHash: s.contentHash, passed: !failure, output: failure?.output ?? null });
        return failure;
      }),
    );
    for (const f of results) if (f) failures.push(f);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { failures, skipped: commits.length - toBuild.length };
}
