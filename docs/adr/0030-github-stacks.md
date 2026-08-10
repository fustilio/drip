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
*what* it does with a graph that isn't a chain, and *who* owns the branches. The
governing preference on the first: **go with GitHub's convention** — use their
command, their vocabulary, their navigation and merge commands — and only
diverge where drip's own guarantees would break.

## Decision

### Use `gh stack link`, and fall back to the API it calls

GitHub's convention comes first: when the `gh stack` extension is installed,
drip groups its PRs by running `gh stack link`. That is GitHub's own command for
precisely drip's situation — branches owned by another tool, no local tracking
written — and preferring it means drip's output is produced the way GitHub
expects rather than by a parallel implementation of the same call.

The extension is not made a hard dependency. Without it, drip calls the
endpoints `link` itself calls:

| Endpoint | Used for |
|---|---|
| `GET /repos/{owner}/{repo}/stacks` | every stack and its ordered members — one read per report |
| `POST /repos/{owner}/{repo}/stacks` | create a stack from PR numbers, bottom to top |
| `POST /repos/{owner}/{repo}/stacks/{n}/add` | append PRs to an existing stack |

Which path ran is reported (`via gh stack link` / `via stacks API`), because the
two are not quite the same command and the difference should never have to be
guessed at.

Three details make delegating to `link` safe, and each is load-bearing:

- **PR numbers are passed, never branch names.** A branch argument makes `link`
  push the branch and open a PR for it. Both are `drip push`'s job, done under
  `--yes` with drip's own rules about leases and adoption, and neither may happen
  as a side effect of grouping.
- **`--base` is the chain's real bottom base.** `link` retargets any PR whose base
  isn't its position in the chain it computed. drip derives the chain *from* the
  bases already on the PRs, so every expected base equals the current one and
  that path never fires — provided the bottom base is passed rather than left to
  default to the repository's default branch.
- **An adopted member's live base is checked first.** The chain comes from
  correspondence, so an adopted PR could have been retargeted on GitHub since
  drip recorded it — the one case where `link` *would* retarget, and where
  docs/adr/0020 says drip must report rather than act. Each adopted member's base
  is read live before the call; a disagreement reports which PR and which two
  bases, and links nothing.

The rest of the extension stays out of it. `init`, `add`, `rebase`, `sync` and
`modify` manage branches and track them in `.git/gh-stack`, and a projection
branch is *derived* — regenerated on each push, never rebased (CONTEXT.md,
"Slice"). drip writes no `.git/gh-stack` file, so none of those commands act on
its branches by accident. Local navigation is available the way GitHub intends
it: `gh stack checkout <n>` pulls the stack down and sets up tracking, and drip
prints that command rather than forging the file behind GitHub's back.

The read path has no extension equivalent at all: `gh stack view --json` loads
`.git/gh-stack`, requires the current branch to be in a tracked stack, and writes
state back. drip needs "which stack holds PR #N" for branches nobody has checked
out, so `stack status` and `review-context` read `GET /stacks` either way.

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

### Record that drip made the stack; read membership live

drip now puts three kinds of object on a review surface — a branch, a PR, and a
stack — and the first two already carry ownership in `correspondence`, because
every rule about force-pushing, retargeting and reclaiming depends on knowing
which of them drip created (docs/adr/0020, 0028). The stack gets the same
treatment: `stack_ownership` records `(mega branch, stack number)` when drip
creates one.

What is **not** recorded is membership. That lives on GitHub, is read live on
every report, and a cached copy could only ever be wrong. The record is exactly
the one bit GitHub doesn't carry: who made this stack.

The distinction pays for itself immediately, at `diverged`. Without it, every
divergence is a dead end — drip can't restructure, because the API only adds and
dissolving somebody's grouping isn't drip's call. With it, the two cases
separate the way they already do for branches: a stack **drip created** is a
derived object whose definition is the mega branch, so `--reclaim` may dissolve
and rebuild it; a stack **someone else created** is never dissolved, flag or no
flag. It is the same flag `push` already uses for a drip-owned branch that
moved, and the same sentence underneath: discarding what drip didn't create
needs a person, rebuilding what drip did create from the mothership needs
permission but not an argument.

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
- **Linking is the default, not a flag.** `gh stack submit` pushes branches,
  opens PRs and creates the stack in one step; a `drip push` that stopped short
  of the stack would be the odd one out. `--no-link-stack` opts out, and says
  what was left ungrouped.
- **drip's output speaks gh-stack's language.** Chains render trunk-first
  (`(main) <- auth#1 <- api#2`), members are *layers*, the bottom base is the
  *trunk*, and the two commands drip prints are `gh stack checkout <n>` and
  `gh stack merge <n> --yes`. Reading drip's report and `gh stack view` side by
  side needs no translation.
- **drip still never merges.** `gh stack merge` is printed, not run — landing a
  stack is a decision, and `push` remains the only command with remote side
  effects beyond stack membership.
- **One extra API read** for `review-context` and `stack status`; at most one
  write per chain for `link`.
- **A third owned object to keep straight.** Branch, PR, stack — each with a
  record of whether drip made it, each with the same rule about what may be
  overwritten. That is a cost, and the alternative was a divergence with no
  remedy.

## Alternatives rejected

- **Call the REST endpoints only, and never `gh stack link`.** This ADR said so
  first, on the grounds that `link` retargets PRs. It does — but not on a chain
  drip derived, because the chain *is* the bases and every expected base equals
  the current one. The claim was true of `link` in general and false of the way
  drip calls it, and the correction is why the extension is now the preferred
  path: the one case where the retarget can genuinely fire (an adopted PR moved
  since drip recorded it) is a live check, not a reason to reimplement GitHub's
  command. Going API-only would also mean tracking a preview-era API by hand,
  where the extension absorbs those changes.
- **Require the extension.** Rejected the other way: an install drip can't make
  on someone's behalf shouldn't decide whether `push` can finish. The endpoints
  are the same ones `link` uses, so the fallback is a fallback, not a second
  behaviour.
- **Write `.git/gh-stack` so `gh stack view`/`up`/`down` work on drip's
  branches.** Tempting — it is the deepest form of "first-class" — and wrong:
  the same file makes `gh stack sync` and `rebase` act on branches drip
  regenerates. `gh stack checkout <n>` gives exactly that navigation, from the
  stack on GitHub, whenever someone wants it.
- **Linearize the DAG so everything becomes one stack.** Fabricates review
  dependencies that don't exist — the exact thing `flat-first` was built to stop
  (docs/adr/0016).
- **Pick a branch of a fork to continue the chain.** Deterministic and
  meaningless: the choice would decide who reviews what, on no evidence.
- **Persist nothing at all about stacks.** This ADR said so first, and it was
  half right: *membership* must not be cached, since GitHub owns it and a copy
  could only be stale. But provenance isn't membership. Without a record of
  which stacks drip created, `diverged` has no way out that isn't either
  guessing or refusing forever — and drip already keeps exactly this record for
  branches and PRs. Corrected: ownership recorded, membership read live.
- **Link by default on every push.** A stack is a real object on someone's
  review surface. It follows drip's existing rule that remote side effects are
  asked for, not inferred — and the report makes the un-taken option visible.
