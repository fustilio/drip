# 0030 — GitHub stacks as the review surface

Status: accepted
Context: GitHub shipped stacked pull requests to public preview on 2026-07-30

## Problem

drip has always produced the shape a stacked-PR tool produces: under
`--projection stacked`, an ordered chain of PRs where each one's base is the
head branch of the PR below it. Until now that chain existed only as a property
of the individual PRs. GitHub had no idea the PRs belonged together, so
reviewers had no way to walk the layers, and landing the chain meant merging
each PR by hand in the right order and waiting for each base to retarget.

GitHub now models the grouping directly. A **stack** is a first-class object
holding an ordered list of PRs that form a base-to-head chain; the PR UI shows
the layers, and `gh stack merge <n>` lands the whole stack — or a prefix of it —
in one all-or-nothing operation. Everything drip was already emitting qualifies.
The only missing piece was the grouping call.

That makes this an integration question with three parts: *what* drip talks to,
*what* it does with a graph that isn't a chain, and *who* owns the branches.

## Decision

### Talk to the stacks REST API, not to the `gh stack` extension

`gh stack` also manages branches: `init`/`add` create them, `rebase` and `sync`
rebase them in place, `modify` restructures them, and all of it is tracked in
`.git/gh-stack`. Every one of those is something drip must not have happening to
its branches. A projection branch is *derived* — regenerated from the mega
branch on each push, never rebased (CONTEXT.md, "Slice"). A `gh stack sync` run
against drip's branches would rebase commits drip is about to recreate, and
`.git/gh-stack` would be a second, conflicting record of a stack whose real
definition is the manifest.

That argument is against `sync`, `rebase` and `modify`, and it does not decide
this on its own — because the extension has a command built for exactly drip's
situation. `gh stack link` writes no local tracking state and documents its
purpose as branches "managed by jj, Sapling, ghstack, git-town, etc." So the
real question is `gh stack link` versus the endpoints it calls, and two things
settle it:

- **`link` retargets PRs it wasn't asked to retarget.** For every argument,
  including PR numbers, it reads the PR and calls `UpdatePRBase` when the base
  isn't the chain position it computed (`cmd/link.go`). drip may not do that: on
  an **adopted** PR the base is a review decision someone else made, reported
  every run and never changed (docs/adr/0020). `link` has no notion of adoption,
  so handing it a chain delegates a decision drip has an ADR promising not to
  take. This is the reason; the branch-management half is a side note.
- **The read path can't use the extension at all.** `gh stack view --json` loads
  `.git/gh-stack`, requires the current branch to be in a tracked stack, and
  writes state back. drip needs "which stack holds PR #N" for branches nobody has
  checked out, so `stack status` and `review-context` are REST whichever way the
  write path goes. Using `link` would mean maintaining both.

What `link` would *not* have done, contrary to a plausible reading: opened PRs
or pushed branches. Both apply to branch arguments, and drip would pass PR
numbers. The retarget is the whole of the conflict.

drip therefore calls the endpoints directly:

| Endpoint | Used for |
|---|---|
| `GET /repos/{owner}/{repo}/stacks` | every stack and its ordered members — one read per report |
| `POST /repos/{owner}/{repo}/stacks` | create a stack from PR numbers, bottom to top |
| `POST /repos/{owner}/{repo}/stacks/{n}/add` | append PRs to an existing stack |

Going direct means the extension is not a dependency, and no `.git/gh-stack`
file is left behind for a later `gh stack sync` to act on. drip already shells
out to `gh` for every other GitHub call, so this adds no new dependency at all.

### A stack is strictly linear; drip's graph is not, and the difference is reported

GitHub stacks have one parent and at most one child per layer. drip's projection
graph is a DAG. Under `--projection stacked` it is already a single chain and
maps exactly. Under `flat-first` it generally doesn't, and the mismatch takes
three shapes, all of them reported rather than resolved:

- **A fan-out** — two projections based on the same one. The chain is linked up
  to the fork and stops there. Which dependent "continues the stack" is a review
  decision no graph settles, so drip picks neither and names both.
- **Several roots** — independent projections targeting the base branch. Each
  root's chain is its own stack. That is correct, not a defect: they are
  independent changes.
- **A generated integration base** — the branch `flat-first` mints to union
  several prerequisites has no PR, so it cannot be a stack member and the
  projection above it starts a new chain. `--reviewable-stack` (docs/adr/0023)
  already refuses that case for the same underlying reason; this is the same
  defect seen from GitHub's side.

The chain relation drip derives is **the base each PR actually targets**, not the
slice DAG: a chain reported here is one GitHub will accept, including where the
two disagree — a squash-merged projection dropped out of the chain, prerequisites
widened, an adopted PR keeping a base drip didn't choose.

### Linking is additive, explicit, and never restructures

`drip stack link <branch> --yes` groups the chains; `drip push --link-stack`
does the same at the end of a push. Four outcomes, decided before any write:

| Outcome | When |
|---|---|
| `created` | no stack holds any of these PRs |
| `extended` | a stack holds a prefix of the chain; the rest is appended |
| `unchanged` | the stack already holds exactly this chain |
| `diverged` | the stack holds these PRs in another order, or across two stacks |

`diverged` writes nothing and names `gh stack unstack`, because the API only
ever adds: removing or reordering a member means dissolving the grouping, which
is a decision about someone's review surface and not one a re-run should take.
Merged members are excluded from the comparison — a merged PR stays in its stack
forever, and comparing against the open members is what stops a second lap
reporting a conflict that isn't one. Open PRs *above* drip's chain are left
alone and reported: they are somebody else's, and the additive API has no
opinion about them either.

`push` reports the chain it produced whether or not `--link-stack` was passed,
in the same spirit as the hidden-base warning: a stack drip could have made and
didn't is not something to discover later.

### Reading is a separate, read-only surface

`drip stack status <branch>` joins drip's chains with GitHub's placement — which
stack each PR is in, which layer, whether it's merged — and prints the
`gh stack merge` command that lands it. It computes what `stack link` *would* do
using the same function `link` uses, so the preview cannot drift from the act.
`drip review-context` gains the same membership per projection, from one list
read, so the per-projection review view says which layer of which stack the PR
is. Both read correspondence rather than replanning: a stack groups PRs that
exist, and whether the *plan* has moved underneath them is `review-context`'s
separate question.

## Consequences

- **drip becomes a producer of GitHub stacks without becoming a stack tool.**
  It keeps deriving branches; GitHub keeps the grouping. Nothing about
  regeneration changes, because a stack tracks PRs, not local branches — a
  force-pushed projection branch keeps its PR and therefore its place in the
  stack.
- **`--projection stacked` gains a concrete advantage** it didn't have before:
  it produces exactly one stack, by construction. `flat-first` produces more
  parallelism and, wherever it forks, a chain GitHub can't hold in one stack.
  That trade-off is now visible in the push report.
- **A repository without the preview enabled degrades cleanly.** The endpoints
  404, the reason is reported, and every other part of push, status and
  review-context still works. Linking is never a precondition for anything.
- **drip still never merges.** `gh stack merge` is printed, not run — landing a
  stack is a decision, and `push` remains the only command with remote side
  effects beyond stack membership.
- **One extra API read** for `review-context` and `stack status`; at most one
  write per chain for `link`.

## Alternatives rejected

- **Depend on the `gh stack` extension and drive `gh stack link`.** Rejected for
  the retarget behaviour above, not for the extension's branch management, which
  `link` doesn't do. Secondary costs: an install drip doesn't otherwise need,
  version skew against a preview-era extension, and a read path that stays REST
  regardless — so the extension would add a dependency without removing any code.
  The cost of *not* depending on it is real and accepted: the stacks API is in
  public preview and may change shape, and the extension would have absorbed that
  where drip won't. Confined to three functions in `github.ts` to keep the blast
  radius small.
- **Linearize the DAG so everything becomes one stack.** Fabricates review
  dependencies that don't exist — the exact thing `flat-first` was built to stop
  (docs/adr/0016).
- **Pick a branch of a fork to continue the chain.** Deterministic and
  meaningless: the choice would decide who reviews what, on no evidence.
- **Persist stack numbers in `.git/drip.db`.** A second record to drift from
  GitHub's, for something one list call answers live. Membership is read where
  it lives, the same way adoption evidence is.
- **Link by default on every push.** A stack is a real object on someone's
  review surface. It follows drip's existing rule that remote side effects are
  asked for, not inferred — and the report makes the un-taken option visible.
