import type { GitBackend, RefKind } from "./git-backend";
import { ghDefaultBranch, ghListOpenPrs } from "./github";

// What `--reviewable-stack` actually asserts, stated once: every base in the PR
// graph is something a reviewer can open. There are exactly three ways a base
// earns that, and everything else is refused (docs/adr/0032).
//
//   1. it is the branch the whole repository merges into — the default branch,
//      which needs no PR because it is what PRs are reviewed against;
//   2. it is itself under review, as an open PR;
//   3. it is a prerequisite projection's own PR branch, which this run leaves
//      on the remote with a PR on it.
//
// A generated integration branch is none of those (docs/adr/0023), and neither
// is a commit sha, a tag, or a branch somebody published to stand in for a
// prerequisite.

export type BaseReview =
  /** the run's base branch, confirmed as the repository's default branch */
  | { kind: "default-branch"; branch: string }
  /** the run's base branch, itself under review as an open PR */
  | { kind: "base-pr"; branch: string; prNumber: number }
  /** the run's base branch, which drip could not confirm either way — dry-run only */
  | { kind: "unconfirmed"; branch: string; reason: string }
  /** a prerequisite projection's own PR branch */
  | { kind: "prerequisite"; projection: string; prNumber: number | null }
  /** a generated integration branch, which has no PR of its own */
  | { kind: "generated" }
  /** `--reviewable-stack` was off, so drip formed no opinion about this base */
  | { kind: "unchecked" };

/** Everything drip can learn about the run's base branch, read once per push. */
export type BaseBranchFacts = {
  base: string;
  /** every `refs/heads/*` on origin, or null when the remote couldn't be read */
  remoteHeads: Map<string, string> | null;
  /** what the name is locally — the question `rev-parse` doesn't answer */
  refKind: RefKind;
  /** the repository's default branch, or null when GitHub couldn't be read */
  defaultBranch: string | null;
  /** open PR numbers by head branch, or null when GitHub couldn't be read */
  openPrHeads: Map<string, number> | null;
};

export type BaseCheck = { ok: true; review: BaseReview } | { ok: false; message: string };

/**
 * Is this base branch one a reviewer can open? Pure — every read is in the
 * facts, so the whole decision table is unit-testable.
 *
 * `requireConfirmation` is "this run will really open PRs": a dry-run against
 * an unreachable GitHub degrades to `unconfirmed` and says so, exactly as the
 * remote-drift check already does, but a run that is about to call
 * `gh pr create` may not decide a base is fine by failing to look.
 */
export function classifyBaseBranch(facts: BaseBranchFacts, requireConfirmation: boolean): BaseCheck {
  const { base, defaultBranch, openPrHeads } = facts;

  // 1. Is it a branch at all — and one GitHub has?
  const structural = baseNamesABranch(facts);
  if (!structural.ok) return structural;

  // 2. It is a branch. Is anything reviewing it?
  if (defaultBranch === null || openPrHeads === null) {
    const reason = "drip could not read this repository from GitHub, so it can't tell whether that branch is the one you merge into or one published to stand in for a prerequisite";
    if (requireConfirmation) {
      return {
        ok: false,
        message:
          `'${base}' is a branch on origin, but ${reason}. ` +
          "A push that opens PRs may not decide a base is reviewable by failing to look — fix `gh` access and re-run, or drop --reviewable-stack.",
      };
    }
    return { ok: true, review: { kind: "unconfirmed", branch: base, reason } };
  }

  if (defaultBranch === base) return { ok: true, review: { kind: "default-branch", branch: base } };

  const prNumber = openPrHeads.get(base);
  if (prNumber !== undefined) return { ok: true, review: { kind: "base-pr", branch: base, prNumber } };

  return {
    ok: false,
    message:
      `'${base}' is a branch on origin that nothing reviews: it has no open PR of its own, and it isn't this repository's ` +
      `default branch ('${defaultBranch}'). Reviewers would see a base with no review surface and no stated intent, and a workflow ` +
      `filtered on the default branch would not run on the PRs above it. Target '${defaultBranch}', or open a PR for '${base}' first. ` +
      "If it stands in for work this run depends on, that work is a projection — declare it in the manifest and let these depend on it.",
  };
}

/**
 * Step one on its own: does the name denote a branch the remote has? Answered
 * against origin whenever origin can be read, and against the clone only when
 * it can't — a PR base is a branch on the remote or it is nothing.
 */
export function baseNamesABranch(facts: Pick<BaseBranchFacts, "base" | "remoteHeads" | "refKind">): { ok: true } | { ok: false; message: string } {
  const { base, remoteHeads, refKind } = facts;
  if (remoteHeads ? remoteHeads.has(base) : refKind === "branch") return { ok: true };
  return { ok: false, message: notABranch(base, refKind, remoteHeads !== null) };
}

function notABranch(base: string, refKind: RefKind, remoteReadable: boolean): string {
  const rule = "A pull request base must be a branch, so GitHub would reject every PR this run opens.";
  switch (refKind) {
    case "commit":
      return (
        `'${base}' is a commit, not a branch. ${rule} Name the branch that holds it — and if none does, the thing that commit ` +
        "stands in for is a projection: declare it in the manifest, push it, or bind it to an existing PR with `drip manifest adopt`. " +
        "drip will not publish a branch for it, because a branch minted to be a base is the hidden base --reviewable-stack exists to refuse."
      );
    case "tag":
      return `'${base}' is a tag, not a branch. ${rule} Name the branch you want these PRs to merge into.`;
    case "remote":
      return `'${base}' is a remote-tracking ref, not a branch. ${rule} Pass the branch name itself — 'main', not 'origin/main'.`;
    case "branch":
      return (
        `'${base}' is a branch in this clone that origin doesn't have. ${rule} Push it first (\`git push -u origin ${base}\`), ` +
        "or target a branch that is already on the remote."
      );
    case "none":
      return remoteReadable
        ? `'${base}' is not a branch on origin, and names nothing in this clone either. ${rule}`
        : `'${base}' names nothing in this clone, and origin could not be read to check there. ${rule}`;
  }
}

/**
 * `classifyBaseBranch` with the reads done. GitHub is consulted only once the
 * name has survived the cheap structural check — there is no point asking who
 * reviews a commit sha.
 */
export function reviewBaseBranch(opts: {
  git: GitBackend;
  repoRoot: string;
  base: string;
  remoteHeads: Map<string, string> | null;
  requireConfirmation: boolean;
}): BaseCheck {
  const { git, repoRoot, base, remoteHeads } = opts;
  const refKind = git.refKind(base, repoRoot);

  const structural = baseNamesABranch({ base, remoteHeads, refKind });
  if (!structural.ok) return structural;

  let openPrHeads: Map<string, number> | null = null;
  try {
    openPrHeads = new Map(ghListOpenPrs(repoRoot).map((pr) => [pr.headRefName, pr.number]));
  } catch {
    openPrHeads = null;
  }
  return classifyBaseBranch(
    { base, remoteHeads, refKind, defaultBranch: ghDefaultBranch(repoRoot), openPrHeads },
    opts.requireConfirmation,
  );
}

/** How a base reads in a plan: the branch, plus what makes it reviewable. */
export function describeBase(base: string, review: BaseReview): string {
  switch (review.kind) {
    case "generated":
      return `${base} (generated, not reviewable on GitHub)`;
    case "prerequisite":
      return `${base} (${review.projection}${review.prNumber === null ? ", PR opens in this run" : `, #${review.prNumber}`})`;
    case "base-pr":
      return `${base} (#${review.prNumber})`;
    case "default-branch":
      return `${base} (default branch)`;
    default:
      return base;
  }
}
