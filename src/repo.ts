import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { DripError } from "./errors";
import type { GitBackend } from "./git-backend";

// `git rev-parse --git-path <name>` resolves to the worktree's private gitdir,
// not a hardcoded `<repoRoot>/.git` (which is a pointer *file*, not a
// directory, in a linked worktree) — see docs/adr/0011-drip-db-location.md.
export function gitPath(repoRoot: string, name: string): string {
  const out = execFileSync("git", ["rev-parse", "--git-path", name], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
  return isAbsolute(out) ? out : join(repoRoot, out);
}

export function resolveRepoRoot(git: GitBackend, targetDir: string): string {
  try {
    return git.showToplevel(targetDir);
  } catch {
    throw new DripError(`'${targetDir}' is not inside a git repository`);
  }
}

export function resolveMergeBase(git: GitBackend, baseBranch: string, branch: string, repoRoot: string): string {
  try {
    return git.mergeBase(baseBranch, branch, repoRoot);
  } catch (e: any) {
    const stderr = String(e.stderr ?? e.message ?? "");
    if (/Not a valid object name|unknown revision/.test(stderr)) {
      throw new DripError(
        `branch '${branch}' or base '${baseBranch}' not found in this repo — if you just cloned, run ` +
          `\`git checkout ${branch}\` first (only the default branch is checked out locally after a fresh clone)`,
      );
    }
    throw new DripError(`could not compute merge-base of '${baseBranch}' and '${branch}': ${stderr.trim() || e.message}`);
  }
}
