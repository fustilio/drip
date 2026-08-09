# 0016 — Flat-first projection

Status: accepted
Context: issue #6

## Problem

`drip push` materialized every selected slice as a strict linear stack: each
PR targeted the preceding slice's branch, and each branch's commit was
parented on the previous one. That is the correct shape for a genuinely
sequential change, but the slice DAG usually isn't sequential — a real
55-commit TypeScript branch produced 114 slices, 122 edges, and **66 roots**.
Stacking turned 66 independently reviewable changes into serial review
dependencies that GitHub then renders as one 114-deep chain.

## Decision

`drip push --projection flat-first` picks each slice's base from the DAG
instead of from the iteration order:

| direct prerequisites | branch is built on | PR targets |
|---|---|---|
| none | the merge-base | the base branch (`main`) |
| exactly one | that prerequisite's commit | that prerequisite's branch |
| two or more | a generated integration commit unioning them | `drip/<branch>/sliceN-base` |

The multi-prerequisite case mints an integration branch rather than blocking
on a human decision: its commit's tree is the transitive prerequisite closure
and its parents are the maximal prerequisite commits, so it reads as a merge
of exactly the branches it unions and the dependent PR's diff is still only
its own slice.

`--projection stacked` remains the default. Flat-first changes what every
PR targets, so it is opt-in until it has run against real branches; the
observed shape of real DAGs says it should eventually become the default.

### Widening, and when a slice is blocked

Flat-first is the first thing in drip that applies a *subset* of the slices.
`git apply` needs exact context, so a slice can fail to apply on its DAG
prerequisites alone when an earlier slice edited nearby lines of the same
file — a real prerequisite the symbol graph never had a way to see.

On failure the prerequisite set is widened *once*, deterministically, to every
earlier slice touching any of this slice's files, and the apply is retried.
That is reported (`prerequisites widened past the slice DAG`) rather than
hidden, because it means the DAG understated a dependency.

If it still won't apply, the slice is reported `blocked` with the underlying
error and is not pushed; `drip push` exits non-zero. A blocked slice is never
silently dropped, and `--projection stacked` always remains available for it.

## Consequence: "unchanged" now means the PR is right, not just the patch

The M3 content hash covered only the slice's own patch text. That was
sufficient while every branch was a prefix of one chain and the base was
implied by position. Under flat-first a slice's patch can be byte-identical
while its branch content and its target ref both move — and the old hash would
have called that "unchanged", skipped the force-push, and left the PR showing
a diff it no longer had.

The hash now covers the slice's patch, the tree its branch resolves to, and
the ref it targets. The materialized commit's *sha* is deliberately not part
of it: `commit-tree` mints a fresh sha on every run, its tree does not.

This also fixes a latent stacked-mode bug of the same shape — editing an early
slice changed every later branch's content while leaving their patches alone,
so they reported `unchanged` and were never re-pushed.

`correspondence.base_ref` records what each PR was last targeted at, so a base
change is detected locally and `gh pr edit --base` is called only when it
actually moved — no `gh pr view` per slice on a no-op run.
