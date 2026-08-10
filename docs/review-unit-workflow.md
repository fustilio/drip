# The review-unit workflow

How a mega branch becomes a set of PRs a team can actually review, and where
each decision is made. Every step here is deterministic and non-AI inside drip;
the one step that needs judgement happens outside it, through the JSON and MCP
interfaces (docs/adr/0009).

Context: issue #16. The scoring that decides whether this workflow is any good
is in `docs/validation.md`.

## The path

```
mega branch
  │
  │  drip plan <branch>                      deterministic, inside drip
  ▼
atomic slice DAG                             hunks clustered by symbol edges
  │
  │  drip plan --coarsen [--target-slices n] deterministic, inside drip
  ▼
candidate projections                        review-sized groups, four rules (docs/adr/0017)
  │
  │  --emit-manifest                         a valid skeleton, no intent invented
  ▼
manifest skeleton                            every slice assigned, mechanical ids
  │
  │  a human or an agent, reading plan --json / drip_plan   ← the judgement step
  ▼
semantic projection manifest                 ids, titles, intent, glue, dependsOn, verification
  │
  │  drip validate-plan [--require-intent] [--require-verification] [--strict]
  ▼
a validated review plan                      every check in docs/adr/0018 + runnable checks (0019)
  │
  │  drip materialize [--output dir]         local refs and worktrees, nothing remote (0022)
  │  drip manifest discover                  which existing PRs already are these projections (0026)
  │  drip manifest adopt … --yes             bind the ones that are (0020)
  ▼
  drip push --manifest [--reviewable-stack] [--draft]
```

## What each layer is allowed to decide

| Layer | Decides | Cannot decide |
|---|---|---|
| Atomic slices | which hunks *must* travel together, from the code | which of them a person wants to review together |
| Candidate projections | review-sized grouping, by four deterministic rules | what any group *is* |
| Semantic manifest | what each PR is, and what it claims to be runnable for | anything the atomic DAG forbids — validation refuses it |

The middle layer is the one that gets over-trusted. Coarsening balances sizes;
it cannot know that six slices are "the report-tab detail experience". That is
product intent, and the manifest exists because no graph heuristic recovers it
(docs/adr/0018).

## What makes a candidate a review unit

Two properties, both checked:

- **Stated intent.** A projection with no `intent` is a set of slices with an
  id, which is what the layer below already produced. `no-intent` warns by
  default and fails under `--require-intent` (docs/adr/0025). Write the
  sentence a reviewer can hold the diff against — "expose and render report,
  offence, offender and vehicle detail", not "changes to report.ts".
- **Declared prerequisites.** `dependsOn` may *widen* what the atomic DAG
  implies but never drop it: an edge crossing a projection boundary is a hard
  ordering constraint discovered from the code. Validation reports every one
  that's missing, and every projection is materialized on its declared
  prerequisite closure to prove it applies there.

And two more the workflow gives you if you ask for them:

- `--require-verification` — a projection containing code must declare a
  command that actually runs (docs/adr/0023), which a shared
  `verificationProfile` can supply (docs/adr/0024).
- `--reviewable-stack` — refuse any PR that would target a generated
  integration base with no PR of its own (docs/adr/0023).

## Where the agent goes

Outside. `drip plan --json` and the `drip_plan` MCP tool expose the ambiguous
boundaries, the symbols, the fallback groups and the DAG; whatever proposes a
grouping reads that and writes back a manifest, which drip then validates
deterministically. There is no model inside drip and no `--ai` flag — see
docs/adr/0009 for why that boundary is the point rather than a limitation.

For work in progress, `plan --worktree` partitions the working tree before the
commits exist (docs/adr/0021), and the resulting manifest's selectors stay valid
once they do.

## Checking the workflow itself

Grouping proposals are worth exactly as much as their agreement with what a
human would have drawn, which is a measurement, not an opinion:

```bash
drip score <branch> --expected hand-drawn.json --layer atomic      # the M0 gate
drip score <branch> --expected hand-drawn.json --layer candidates  # coarsening
drip score <branch> --expected hand-drawn.json --layer manifest    # the review plan
```

Scoring the same hand-drawn partition at all three layers is what says whether
each layer earns its existence: a partition that scores 50% against the atomic
slices and 100% against the manifest projections is the manifest layer doing
exactly the job it was added for. See `docs/validation.md` for the method,
the threshold, and the ledger of what has actually been scored.
