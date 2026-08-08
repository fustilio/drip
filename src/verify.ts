import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { GitBackend } from "./git-backend";
import { materializeSliceCommits } from "./materialize";
import type { FileSection, Hunk } from "./planner";

export const DEFAULT_BUILD_CMD = "bunx tsc --noEmit";

export async function verifyTreeHash(opts: {
  git: GitBackend;
  repoRoot: string;
  branch: string;
  mergeBase: string;
  files: FileSection[];
  order: string[];
  slices: Map<string, Hunk[]>;
}): Promise<{ pass: boolean; message: string }> {
  const { git, repoRoot, branch, mergeBase, files, order, slices } = opts;
  const expected = git.revParse(`${branch}^{tree}`, repoRoot);
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-verify-tree-"));
  const indexFile = join(tmpDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  try {
    git.readTree(mergeBase, repoRoot, env);
    for (const id of order) {
      const hunksInSlice = new Set(slices.get(id)!.map((h) => h.index));
      for (const file of files) {
        const selected = file.hunks.filter((h) => hunksInSlice.has(h.index));
        if (!selected.length) continue;
        const patch = file.header + selected.map((h) => h.raw).join("");
        const patchFile = join(tmpDir, "patch.diff");
        writeFileSync(patchFile, patch);
        try {
          git.applyCached(patchFile, repoRoot, env);
        } catch (e) {
          return { pass: false, message: `INVARIANT: FAIL — could not apply ${id} to ${file.path}\n${String(e)}` };
        }
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

export async function verifyPerSliceBuild(opts: {
  git: GitBackend;
  repoRoot: string;
  mergeBase: string;
  files: FileSection[];
  order: string[];
  slices: Map<string, Hunk[]>;
  idToNum: Map<string, number>;
  buildCmd: string;
}): Promise<{ failures: Array<{ slice: string; output: string }> }> {
  const { git, repoRoot, idToNum, buildCmd } = opts;
  const commits = await materializeSliceCommits(opts);
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-verify-build-"));
  const failures: Array<{ slice: string; output: string }> = [];
  const nodeModulesSrc = join(repoRoot, "node_modules");

  try {
    for (const { sliceId, commit } of commits) {
      const sliceLabel = `slice${idToNum.get(sliceId)}`;
      const worktreePath = join(tmpDir, `wt-${idToNum.get(sliceId)}`);
      git.worktreeAdd(worktreePath, commit, repoRoot);
      try {
        if (existsSync(nodeModulesSrc)) {
          // Junctions don't require elevated privileges on Windows; plain
          // symlinks do. Elsewhere a normal dir symlink is fine.
          symlinkSync(nodeModulesSrc, join(worktreePath, "node_modules"), platform() === "win32" ? "junction" : "dir");
        }
        try {
          execSync(buildCmd, { cwd: worktreePath, stdio: "pipe" });
        } catch (e: any) {
          const output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") || e.message;
          failures.push({ slice: sliceLabel, output });
        }
      } finally {
        git.worktreeRemove(worktreePath, repoRoot);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { failures };
}
