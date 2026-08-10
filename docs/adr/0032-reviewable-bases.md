# 0032 — A base a reviewer can open

Status: accepted
Context: issue #14 (follow-up comment)

## Problem

`--reviewable-stack` (docs/adr/0023) refused exactly one shape: a projection
needing a *generated integration base*, the branch drip mints to union two or
more prerequisites. That turned out to be one instance of a wider rule the flag
was implicitly claiming and not enforcing.

Reported against a real run: a projection with **one** real implementation
prerequisite, pushed with `--reviewable-stack` and a **commit sha** as `--base`.
drip materialized it correctly and then called `gh pr create --base <sha>`,
which GitHub rejected — a pull request base must be a branch. The flag that
exists to guarantee a reviewable PR graph let the run get all the way to the
API before anything noticed.

The workaround made it worse. Publishing a branch at that sha made the command
succeed and put back precisely the defect issue #14 was about: reviewers see a
base branch with no PR, no stated intent and nothing to open, and a workflow
declared as `pull_request.branches: [main]` doesn't run on the PRs above it.
The branch was minted by hand instead of by drip; the hidden base is the same
hidden base.

Two gaps, then:

- **`--base` was never checked at all.** `rev-parse` resolves a sha, a tag and
  a remote-tracking ref to a commit just as happily as a branch, so nothing
  upstream of `gh` ever asked which of those it was.
- **A prerequisite's base was assumed reviewable, not established.** With one
  prerequisite the base is that projection's branch, and drip took for granted
  that a PR would be on it.

## Decision

State the flag's rule once, and enforce all of it. Under `--reviewable-stack`,
every base in the PR graph is one of exactly three things:

1. the repository's **default branch** — the one base that needs no PR, because
   it is what PRs are reviewed *against*;
2. a branch that is **itself under review**, as an open PR;
3. a **prerequisite projection's own PR branch**, which this run leaves standing
   on the remote with a PR on it.

Everything else is refused: a commit sha, a tag, a remote-tracking ref, a branch
origin doesn't have, a branch nothing reviews, and — as before — a generated
integration branch.

### The base branch is checked before anything is materialized

`src/reviewable.ts` holds the whole decision as a pure function over facts that
are read once (`classifyBaseBranch`), plus a thin gatherer. `push()` runs it
before it materializes a single commit, and refuses the run rather than
reporting per projection: `--base` is one value for the whole push, so a
per-projection `blocked` would say the same thing N times about a mistake made
once.

Answering "is this a branch" needs a question `rev-parse` doesn't answer, so
`GitBackend` gained `refKind`, which asks `show-ref --verify` about each full
refname in turn and only falls through to `rev-parse` for a name that is no ref
at all. That is what makes the message specific — "is a commit, not a branch",
"is a tag", "'main', not 'origin/main'" — instead of a flat "not found".

Branch-ness is decided against **origin**, since that is what GitHub can target,
and against the clone only when origin can't be read.

### An unreviewed base branch is refused, and the remedy is never a new branch

The published-stand-in case is the one this ADR exists for, and refusing it
needs a fact from GitHub: the default branch (`gh repo view`, new
`ghDefaultBranch`) and the open PRs (`ghListOpenPrs`, already there). A branch
that is neither gets refused with both ways out named — target the default
branch, or open a PR for this one — and a third possibility spelled out: if the
branch stands in for work this run depends on, that work is a *projection*.
Declare it in the manifest and let these depend on it.

What drip will not do is offer to publish a base branch itself. That is the same
declined option as docs/adr/0023's: drip would be inventing a review unit with
no title, no intent and no verification commands, in a manifest whose premise is
that those come from outside drip (docs/adr/0018).

Reading the default branch from GitHub rather than from `origin/HEAD` is
deliberate: `origin/HEAD` is a clone-time snapshot that a repository created by
`git init` doesn't have at all, and a base check that silently passes because a
ref is missing is not a check.

### A question drip couldn't answer is not an answer

If GitHub can't be read, a **real** push refuses — a run about to call
`gh pr create` may not decide a base is reviewable by failing to look — and a
**dry-run** reports `unconfirmed` and says what it couldn't tell. That is the
same asymmetry the remote-drift read already uses (docs/adr/0028): a dry-run is
expected to work offline and to say that its answer is weaker for it.

### A prerequisite's base is established, not assumed

`push()` now tracks the branches a run actually leaves standing with a PR on
them, and a projection whose base is a prerequisite's branch is checked against
that set. Absent means refused, naming the prerequisite projection and telling
the caller to push it in this run or bind it to the PR that already implements
it with `drip manifest adopt`.

Within a single run the set is always complete — every projection is pushed, and
a prerequisite that was blocked or squash-merged is already handled by the
`blockedIds` and `droppedToBase` paths above it — so this is a defensive
invariant today rather than a reachable refusal. It is worth having as code
because "the base is reviewable" stops being an assumption the loop happens to
satisfy, and because the tracked set is what lets the plan *name* the base.

### The plan says what makes each base reviewable

`PushResult.baseReview` carries the answer structurally, and the result line
prints it: `base: main (default branch)`, `base: drip/f/shared
(shared-contract, #12)`, and in a dry-run — where the prerequisite's PR doesn't
exist yet — `base: drip/f/shared (shared-contract, PR opens in this run)`. A
run that passes says so in one summary line, because "every base is one a
reviewer can open" is the claim the flag exists to make and it shouldn't be
inferred from the absence of errors.

## Consequences

- `--reviewable-stack` is no longer a no-op under `--projection stacked`: the
  base branch check applies to every projection mode, and stacked mode's bases
  are prerequisite branches like any other.
- `push` now makes two GitHub reads it didn't before — but only under
  `--reviewable-stack`, and neither is a write. A dry-run without the flag still
  touches GitHub not at all.
- A repository whose integration branch is not the default branch (`develop`, a
  release branch) must open a PR for it or drop the flag. That is a real cost,
  accepted: the alternative is a rule with an exception drip can't distinguish
  from the defect it is meant to catch.
- The flag stays opt-in, and the default is still a generated integration base
  under `flat-first` — unchanged from docs/adr/0023, for the same reason.
