# 0021 — The working tree as a diff source

Status: accepted
Context: issue #12

## Problem

`drip plan <branch>` diffs committed history. On a real branch with an
in-progress auth-boundary refactor, that meant the plan listed committed docs
and none of the uncommitted files the refactor actually lived in — so drip
could not propose a review partition *before* the commits existed.

That is backwards. Deciding "this is three PRs: shared-root cleanup, and two
route-local provider moves that depend on it" is most useful while the work is
still a single pile of edits, because the answer tells you what to commit.
Requiring commits first means committing blind and re-cutting afterwards.

## Decision

`--worktree` on `plan` and `verify`, which substitutes the diff source and
changes nothing else.

drip's model is "everything between the base branch and the mega branch's
tip", and every consumer downstream — planner, tree-hash verifier,
materializer — only ever needs a **tree-ish** for that tip. So worktree mode
builds one: `HEAD`'s tree with every non-ignored change staged on top —
staged, unstaged and untracked alike — written with `git write-tree` into a
**scratch index**, never the repo's own. The result is an ordinary tree object
that `git diff`, `git show` and `rev-parse <tree>^{tree}` all accept, so there
is no parallel pipeline to keep in step.

Two things follow from that, and both are deliberate:

- **The plan stays base-relative**, not HEAD-relative. Committed work on the
  branch and uncommitted work in the tree are one change to partition. Slicing
  only the uncommitted delta would produce slices that don't apply on the base
  branch, which is the one property every slice has to have.
- **Identity is the branch, not the tree.** Overrides, correspondence and the
  manifest are keyed to the branch the work will land on, so a worktree plan
  inherits decisions already made about the same change, and a manifest emitted
  from it validates unchanged once the commits exist (its selectors are durable
  group keys — docs/adr/0004, docs/adr/0018). Naming a branch that isn't the
  checked-out one is refused rather than treated as a relabel.

### Requested, never inferred, and never silently substituted

A clean worktree in `--worktree` mode produces a plan of committed history —
which is correct, and is also exactly the situation where a reader would draw
the wrong conclusion. So the source is always reported: `plan` prints one line
naming it, and `--json` carries a `source` object with `kind`, `dirty` and the
list of uncommitted files. drip never picks worktree mode on its own, and never
quietly falls back to it or from it.

### Excluded sections are now reported everywhere

`parseDiff` has always dropped diff sections it can't turn into hunks — binary
files, pure renames, mode-only changes, empty file creations. That was
invisible until the tree-hash invariant failed and named no cause, and issue
#12 asks for it directly ("reports files excluded from the plan, if any").

`PlanResult.excluded` now carries them with a reason and a path; `plan` prints
an EXCLUDED section, `--json` includes it, and — the part that matters — a
tree-hash failure lists them, because an excluded section is in the diff and in
no slice and therefore *guarantees* the mismatch it would otherwise be blamed
for. This applies to committed plans too; worktree mode only made it likelier
to be hit, since an untracked PNG is a normal thing to have lying around.

### Planning is read-only; push isn't allowed near it

`plan --worktree` must be safe to run mid-edit, so the index and working tree
are never touched. It does write blobs for untracked files into the object
database — unreferenced, collected like any other loose object — which is the
price of getting a real tree, and cheaper than reimplementing diff against a
mixture of index and filesystem.

`push --worktree` and `--assign-ids --worktree` are refused. Push opens real
PRs from content that exists nowhere but one working tree, and `--assign-ids`
rewrites commits that the uncommitted work isn't in. Both would half-work; the
error names the order to do things in instead.

## Consequences

- `computePlan` takes an optional `sourceRef` and `mergeBase`. `branch` is now
  explicitly the plan's *identity* and `sourceRef` its *content* — they differ
  only in worktree mode.
- `parseDiff` returns `{ files, excluded }` rather than a bare array. One other
  caller (`anchors.ts`) destructures; there is no behaviour change there.
- `verifyTreeHash` takes an optional `sourceRef`, so `verify --worktree` proves
  the slices reconstruct the working tree. Same claim, different tip.
- `drip_plan` and `drip_verify` take a `worktree` flag over MCP, with `branch`
  now optional. This is the mode an agent wants most: it can propose a
  partition from `plan --json --worktree` before any git state changes, which
  is what issue #12 asks for by "dry-run output suitable for agent review".
- Ignored files are excluded by git's own rules, not by drip. Listing them
  would mean listing `node_modules`, so they are not reported as exclusions —
  only sections that reached the diff and couldn't be sliced are.
