import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DripError } from "./errors";
import type { GitBackend } from "./git-backend";
import { resolveMergeBase } from "./repo";

// Where a plan's "after" state comes from (issue #12).
//
// drip's model is "everything between the base branch and the mega branch's
// tip", and every command downstream — planner, verify, materialize — only
// ever needs a *tree-ish* for that tip. So worktree mode doesn't need a
// parallel pipeline: it substitutes a different tip, built from the working
// tree, and the rest of the tool is unchanged.
//
// The tip is still base-relative, not HEAD-relative. Committed work on the
// branch plus what's still uncommitted is one change to partition — that's the
// whole point of planning before the commits exist, and slicing only the
// uncommitted delta would produce slices that don't apply on the base.

export type DiffSource = {
  kind: "branch" | "worktree";
  /** identity for overrides, correspondence, manifests and labels */
  label: string;
  /** tree-ish the changed content is read from — a branch, or a synthetic worktree tree */
  ref: string;
  mergeBase: string;
  /** worktree mode: what the tree carries beyond HEAD */
  uncommitted: Array<{ status: string; path: string }>;
};

// A real tree object for the working tree as it stands: HEAD's tree with every
// non-ignored change staged on top — modified, staged, unstaged and untracked
// alike. Built in a scratch index so the repo's own index is untouched, which
// is what makes `plan --worktree` safe to run mid-edit.
export function worktreeTree(git: GitBackend, repoRoot: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-worktree-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmpDir, "index") };
  try {
    git.readTree("HEAD", repoRoot, env);
    git.addAll(repoRoot, env);
    return git.writeTree(repoRoot, env);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function resolveDiffSource(
  git: GitBackend,
  repoRoot: string,
  opts: { branch?: string; baseBranch: string; worktree: boolean },
): DiffSource {
  const { branch, baseBranch, worktree } = opts;

  if (!worktree) {
    if (!branch) throw new DripError("a mega branch is required (or pass --worktree to plan the working tree instead)");
    return { kind: "branch", label: branch, ref: branch, mergeBase: resolveMergeBase(git, baseBranch, branch, repoRoot), uncommitted: [] };
  }

  // The label decides which overrides, manifest and correspondence this plan
  // belongs to, so it has to be the branch this work will land on — not a name
  // that happens to be typed. Planning *this* worktree under another branch's
  // identity would quietly attach the decisions to the wrong change.
  const current = git.currentBranch(repoRoot);
  if (branch && current && branch !== current) {
    throw new DripError(
      `--worktree plans the working tree, which is on '${current}', but '${branch}' was named — check out '${branch}' first, or drop the branch argument`,
    );
  }
  const label = branch ?? current;
  if (!label) throw new DripError("HEAD is detached, so --worktree has no branch name to file this plan under — pass one explicitly");

  const head = git.revParse("HEAD", repoRoot);
  const ref = worktreeTree(git, repoRoot);
  return {
    kind: "worktree",
    label,
    ref,
    mergeBase: resolveMergeBase(git, baseBranch, "HEAD", repoRoot),
    uncommitted: git.diffNameStatus(head, ref, repoRoot),
  };
}

export const isDirty = (source: DiffSource) => source.uncommitted.length > 0;

// The machine-readable half of describeSource. An agent reading `plan --json`
// has to be able to tell a worktree plan from a branch plan — and, for a
// worktree plan, exactly which uncommitted files it rests on, since those can
// change under it between the plan and the commits.
export function sourceToJson(source: DiffSource): object {
  return {
    kind: source.kind,
    branch: source.label,
    ref: source.ref,
    mergeBase: source.mergeBase,
    dirty: isDirty(source),
    uncommitted: source.uncommitted,
  };
}

// Worktree mode is requested, not inferred, so a clean tree has to say so:
// the plan it produces is a committed-history plan, and reading it as "these
// are my uncommitted changes" would be exactly the wrong conclusion.
export function describeSource(source: DiffSource): string {
  if (source.kind === "branch") return `source: branch ${source.label}`;
  if (!isDirty(source)) {
    return `source: working tree of ${source.label} — clean, so this plan covers committed history only (nothing uncommitted to add)`;
  }
  const counts = new Map<string, number>();
  for (const { status } of source.uncommitted) counts.set(status[0]!, (counts.get(status[0]!) ?? 0) + 1);
  const label = (k: string) => ({ A: "added", M: "modified", D: "deleted", T: "type-changed" })[k] ?? k;
  const summary = [...counts].sort().map(([k, n]) => `${n} ${label(k)}`).join(", ");
  return `source: working tree of ${source.label} — ${source.uncommitted.length} uncommitted file(s) included (${summary})`;
}
