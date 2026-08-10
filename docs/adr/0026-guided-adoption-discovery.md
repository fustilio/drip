# 0026 — Guided adoption: discovery is read-only and evidence-based

Status: accepted
Context: issue #17

## Problem

`drip manifest adopt` requires the projection id, the PR number and the head
branch, and cross-checks all three before binding anything (docs/adr/0020).
That is the right bar for the write: a wrong binding eventually force-pushes a
projection over a branch it doesn't own.

It also leaves the reader to produce the mapping by hand, from a list of open
PRs whose titles say what someone *meant* rather than what the branch
*contains*. On a real integration branch with a dozen projections and thirty
open PRs, "which of these is this projection?" gets answered by reading names.
Guessing is the thing the command was designed to stop; doing the guessing in
someone's head rather than in code is not safer, it is only less visible.

## Decision

`drip manifest discover <branch>` answers the same question adoption asks,
without writing anything.

**The evidence is identical to adoption's.** For each open PR, fetch its head,
replay the branch's effective diff (`merge-base(base, head)..head`) onto the
mega branch's merge base, and compare the resulting tree with the tree each
unbound projection materializes. A PR is a candidate when the trees are equal.
Nothing scores titles, branch-name similarity, authorship or file overlap —
a match here means the same thing a match in `adopt` means, and a candidate
discovery offers is one adoption will accept.

**The near-miss that matters is named.** A branch that carries a projection's
own change but was cut from the base branch rather than from its prerequisites
is reported as `own-change-only`, with the prerequisites it is missing. That
shape reads identically to "wrong PR" in a raw diff and means something quite
different; adoption already calls it out by name (docs/adr/0020) and discovery
would be worse than useless if it silently reported "no candidate" for the
commonest real case.

**Ambiguity is reported, not resolved.** Two open PRs carrying the same tree
are indistinguishable by content, so both are offered with that stated. Picking
the first and calling it a match would be a heuristic wearing evidence's
clothes.

**The output is a command, not an action.** Each candidate prints the exact
`drip manifest adopt … --yes` invocation. Adoption stays an explicit decision
that re-checks all three of projection, PR and head branch — discovery
shortens the typing, never the checking.

**Nothing is written.** No correspondence, no push, no retarget, no comment,
no PR state. The only GitHub call is `gh pr list`; the only local writes are
the fetches into `FETCH_HEAD` and the scratch index that every materialization
already uses. Drip-owned branches (`drip/<branch>/…`) and heads already bound
to a projection are skipped rather than offered — one is drip's own output, the
other already belongs to a projection.

## Consequences

- Discovery costs one fetch and one index replay per open PR, plus one
  materialization pass. `--limit` (default 50) bounds the first term; a large
  repository should narrow it rather than have drip guess which PRs matter.
- A PR whose branch can't be fetched, or whose diff won't replay onto the merge
  base, is reported as skipped with the reason — the same "rebase and try
  again" diagnosis adoption gives, rather than being dropped from the report.
- Discovery is a separate subcommand rather than a mode of `adopt`. `adopt`
  takes a decision and writes correspondence; this takes no decision and writes
  nothing, and collapsing them would mean the safest command in the pair grew a
  flag that made it the most dangerous one.
