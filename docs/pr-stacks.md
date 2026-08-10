# PR stacks

GitHub shipped stacked pull requests to public preview on 2026-07-30. A
**stack** is a first-class object grouping an ordered chain of PRs, each based
on the head branch of the one below it: reviewers walk the layers in the PR UI,
and `gh stack merge <n>` lands the chain — or a prefix of it — in one
all-or-nothing operation.

drip has emitted that shape since M2. `drip push --projection stacked` produces
exactly an ordered chain of PRs chained base-to-head; what was missing was the
grouping object. This document is the whole of that integration: what drip
creates, what it owns, what it reads, and which commands are GitHub's rather
than drip's.

`docs/review-unit-workflow.md` is the forward path (mega branch → review plan →
PRs). `docs/review-feedback-loop.md` is what arrives from outside afterwards.
This sits between them: the stack is what makes the PR set legible as the one
change it came from.

## The mothership owns everything downstream

One rule explains every decision below.

**The mega branch is the source of truth.** Not the projection branches, not
the PRs, not the stack. Those are *derived*: regenerated from the mega branch on
each push, never rebased, never hand-maintained (CONTEXT.md, "Slice"). A change
that exists only on a projection branch is a change the next replan cannot see.

Which makes the ownership question the important one, because drip now puts
three kinds of object on someone's review surface, and it must be able to tell
which of them are its own to rebuild:

| Object | Ownership recorded in | drip-owned means | Someone else's means |
|---|---|---|---|
| **Branch** | `correspondence.slice_branch`, with the last sha drip wrote | regenerated and force-pushed under a lease; `--reclaim` overwrites drift | adopted (docs/adr/0020): leased, never retargeted, `manifest adopt` re-binds |
| **PR** | `correspondence.pr_number` / `adopted` | opened by drip, retargeted to match the manifest graph | adopted: base reported, never changed |
| **Stack** | `stack_ownership` (branch, stack number) | `--reclaim` dissolves and rebuilds it from the mega branch | reported, never dissolved — with or without the flag |

Each row is the same sentence: **discarding something drip didn't create needs
a person; rebuilding something drip did create from the mothership needs
permission, not an argument.**

What is deliberately *not* recorded is stack membership itself. That lives on
GitHub and is read live on every report. A local mirror of it could only ever be
wrong, and drip has no use for a second opinion about a fact GitHub owns. The
record is one bit GitHub does not carry: who made this stack.

## The chain

A GitHub stack is **strictly linear** — one parent, at most one child. drip's
projection graph is a DAG. Reconciling those is most of the work.

drip derives the chain from **the base each PR actually targets**, not from the
slice DAG:

```
PR #12 (base: drip/mega/api)      ← top
PR #11 (base: drip/mega/auth)
PR #10 (base: main)               ← bottom, trunk = main
```

Deriving it that way means a chain drip reports is one GitHub will accept, and
it stays right where the plan and the PRs disagree — a squash-merged projection
that dropped out, prerequisites that widened, an adopted PR keeping a base drip
didn't choose.

`--projection stacked` produces exactly one chain, by construction. `flat-first`
optimizes for independent review instead, and three shapes then can't be one
stack. All three are reported, none is resolved by guessing:

| Shape | What drip does |
|---|---|
| **Fan-out** — two projections on the same prerequisite | Links the chain up to the fork, names both dependents, adds neither. Which one continues the stack is a review decision no graph settles. |
| **Several roots** — independent projections on the base branch | Each root's chain becomes its own stack. Not a defect: they are independent changes. |
| **Generated integration base** — `flat-first`'s minted union branch | Has no PR, so it can't be a stack member; the projection above it starts a new chain. `--reviewable-stack` (docs/adr/0023) refuses that case outright, and it is the same defect seen from GitHub's side. |

Anything left out of a chain is named, including PRs sitting *above* a fork —
a PR that appears in no line of the report is the one outcome worth ruling out.

## Creating the stack

Linking happens **by default**, in the same run that pushes — the way
`gh stack submit` pushes branches, opens PRs and creates the stack in one step.

```bash
drip push mega --manifest .drip/projections/mega.json --yes   # pushes, opens PRs, links the stack
drip push mega --yes --no-link-stack                          # ...or don't, and say what was left ungrouped
drip stack link mega --yes                                    # group PRs that already exist
drip stack link mega --dry-run                                # the chains, reading nothing
```

**GitHub's command runs when it's installed.** With the `gh stack` extension
present, grouping goes through `gh stack link` — GitHub's own command for
branches another tool owns, which writes no local tracking state. Without it,
drip calls the endpoints `link` itself calls, so an extension drip can't install
on your behalf never decides whether a push finishes. The report says which ran:

```
STACKS (1 chain(s)):
  stack #4 [created] via gh stack link: (main) <- auth#101 <- api#102  https://github.com/o/r/stacks/4
      work on it locally: gh stack checkout 4
      land it with:       gh stack merge 4 --yes
```

Three details make delegating to `link` safe, and each is load-bearing:

- **PR numbers are passed, never branch names.** A branch argument makes `link`
  push the branch and open a PR for it — that is `drip push`'s job, done under
  `--yes` with drip's own rules about leases and adoption.
- **`--base` is the chain's real bottom base.** `link` retargets any PR whose
  base isn't its position in the chain it computed. drip derives the chain *from*
  those bases, so every expected base equals the current one and the retarget
  path never fires — as long as the real base is passed rather than left to
  default to the repository's default branch.
- **An adopted member's live base is read first.** The chain comes from
  correspondence, so an adopted PR may have been retargeted on GitHub since drip
  recorded it. That is the one case where `link` genuinely would override a
  review decision someone else made, so drip checks, reports both bases, and
  links nothing.

### The four outcomes

Decided from one list read, before anything is written:

| Outcome | When | What is written |
|---|---|---|
| `created` | no stack holds any of these PRs | the stack, and drip's ownership record |
| `extended` | a stack holds a *prefix* of the chain | only the missing top layers |
| `unchanged` | the stack already holds exactly this chain | nothing — no call at all |
| `diverged` | another order, or the PRs spread across two stacks | nothing |

Merged members are excluded from the comparison: a merged PR stays in its stack
forever, and comparing against the open members is what stops a second lap
reporting a conflict that isn't one. Open PRs *above* drip's chain are left alone
and named — they're somebody else's, and the additive API has no opinion about
them either.

### Divergence, and the mothership

`diverged` means GitHub's grouping and the mega branch disagree about what the
stack holds. drip writes nothing, and what it says next depends on the record:

```bash
# a stack drip created: the mega branch defines it, so it can be rebuilt
drip stack link mega --yes --reclaim
drip push mega --yes --reclaim         # same flag, same meaning, also covers drifted branches

# a stack drip did not create: --reclaim does not apply, and says so
gh stack unstack 7                      # your call, not drip's
```

`--reclaim` dissolves the stack and groups the chain again from the mega branch.
It is the same flag that force-pushes a drip-owned branch that moved
(docs/adr/0028), and it carries the same rule: it never touches an object drip
didn't create. The reason drip *can* offer it for its own stacks is the rule at
the top of this document — the mothership is the source of truth, so rebuilding
a derived object from it loses nothing.

## Reading the stack

Both read-only. Neither creates, changes or dissolves anything.

```bash
drip stack status mega                 # the chains, GitHub's placement, ownership
drip stack status mega --json
drip review-context mega               # per projection: PR, drift, threads — and its layer
```

```
STACKS (mega, 1 chain(s)) — read-only:

  stack #4 [drip] — grouped on GitHub exactly as drip has it  https://github.com/o/r/stacks/4
    (main) <- auth#101 <- api#102
    auth — #101 on drip/mega/auth [drip] open, layer 1 of stack #4
    api  — #102 on drip/mega/api  [drip] open, layer 2 of stack #4
    work on it locally: gh stack checkout 4
    land it with:       gh stack merge 4 --yes
```

`stack status` computes what `stack link` *would* do using the same function
`link` uses, so the preview cannot drift from the act. It reads correspondence
rather than replanning: a stack groups PRs that exist, and whether the plan has
moved underneath them is `review-context`'s separate question.

Over MCP, `drip_stack_status` exposes the same report. There is no
`drip_stack_link` counterpart, for the same reason there is no `push` tool:
creating a stack is a real side effect on someone's review surface and needs
`--yes` from a person.

## Which commands are GitHub's

drip creates the stack and reads it. It does not navigate or land it, and it
prints the command that does rather than running it:

| You want to | Command | Why it's not drip's |
|---|---|---|
| Land the stack, or a prefix | `gh stack merge <n> --yes` | Merging is a decision; `push` is drip's only remote write beyond stack membership |
| Move between layers locally | `gh stack checkout <n>`, then `up`/`down`/`top`/`bottom` | Needs `.git/gh-stack`, which drip deliberately doesn't write — see below |
| Dissolve a stack drip didn't create | `gh stack unstack <n>` | drip never dissolves someone else's grouping |
| See the stack as GitHub renders it | `gh stack view --json` (after `checkout`) | drip's own read is `drip stack status` |

### Why drip writes no `.git/gh-stack`

Writing that file is the deepest-looking integration available: `gh stack view`,
`up`, `down` and `top` would work on drip's branches immediately. It is also the
one that breaks things. The same file makes `gh stack sync` and `gh stack rebase`
act on those branches — rebasing commits that the next `drip push` regenerates
from the mega branch, which is the collision this whole tool is arranged to
avoid.

`gh stack checkout <n>` is GitHub's own way to make a stack that lives on GitHub
locally navigable. Someone who wants that gets it in one command, deliberately,
knowing the branches are now tracked. drip prints it and stays out of the way.

## When the preview isn't enabled

The stacks endpoints 404 on a repository without stacked PRs turned on. Every
part of drip keeps working: `push` pushes, PRs open, `verify` verifies,
`review-context` reports everything except stack membership, and the reason is
stated rather than silently rendered as "in no stack". Linking is never a
precondition for anything.

## See also

- `docs/adr/0030-github-stacks.md` — the decisions, and the one this ADR reversed
- `docs/adr/0020-adopting-existing-prs.md` — the ownership rule for branches and PRs
- `docs/adr/0028-remote-drift-on-owned-branches.md` — `--reclaim` for branches
- `docs/adr/0023-reviewable-stacks-and-runnable-checks.md` — `--reviewable-stack`
- `docs/adr/0016-flat-first-projection.md` — why the graph is a DAG in the first place
- `docs/review-feedback-loop.md` — what happens to the PRs after they exist
