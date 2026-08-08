import { DripError } from "./errors";
import type { GitBackend } from "./git-backend";

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
