# Validation

What has been measured, what it licenses drip to claim, and what is measured
next. Context: issues #15 and #16.

This document holds outcomes and method only. **No customer, repository,
branch, PR or local-environment detail belongs here** — the material a
validation exercise runs against lives in the private workspace that owns it,
and only the resulting numbers come back.

## Method

The question is BUILD-PLAN §7's, unchanged since before anything was built:

> Are the proposed boundaries ones you'd have drawn by hand? If under
> two-thirds are, stop.

The procedure:

1. **Draw the boundaries blind.** Before looking at drip's output, partition the
   branch by hand into the units you would have reviewed, and write them down as
   a v1 partition file — `{ "version": 1, "units": [{ "id", "selectors" }] }` —
   using durable group-key selectors (`file::Symbol`, `file::(file)`). Blind is
   the load-bearing word: a partition drawn after reading the plan measures how
   persuasive the plan is, not how right it is.
2. **Score it.** `drip score <branch> --expected <file> --layer <layer>`.
   The metric is boundary agreement under a one-to-one match between hand-drawn
   and drip units — splits and merges each cost something, and every
   disagreement is reported by selector (docs/adr/0025).
3. **Record the number here**, with the layer, the threshold and the shape of
   the disagreements. Not the repository, the branch, or the code.

Thresholds:

| Layer | Threshold | Why |
|---|---|---|
| `atomic` | 2/3 | BUILD-PLAN's M0 kill gate, verbatim |
| `candidates` | 2/3 | same bar, one layer up: coarsening claims to produce review-sized groups |
| `manifest` | agreed per exercise | a manifest is authored, so the interesting number is how far it moves the score above the layers below it |

Three real mega branches is the M0 gate's stated sample. One branch is an
anecdote; the gate was written for three.

## Ledger

| Exercise | Layer | Branches | Agreement | Threshold | Outcome |
|---|---|---|---|---|---|
| M0 kill gate | `atomic` | 0 of 3 | — | 2/3 | **not scored** |
| Review-unit workflow | `candidates`, `manifest` | 0 | — | 2/3 | **not scored** |

The instrument landed before the exercises did. As of this writing the ledger
is empty on purpose: no blind hand-drawn partition has been scored against
drip's output, at any layer, so there is no result to record — and recording an
impression as if it were a measurement is the failure mode this whole document
exists to prevent. Scoring an exercise means adding a row above and updating
the claims below; the private evidence stays in the workspace that owns it.

## What drip may and may not claim, today

**May claim**, because these are checked mechanically on every run and covered
by the test suite:

- Slices, coarsened projections and manifest projections **reconstruct the mega
  branch's tree exactly**, deferred work included. This is verified, not
  asserted (`verify`, `validate-plan`).
- Each projection **applies on its declared prerequisite closure**, and each
  one's declared verification commands **actually ran** against its own
  materialized tree (docs/adr/0019).
- Correspondence, adoption and pushes behave as documented against real git —
  see STATUS.md's "What's verified, not just written".

**May not claim**, until the ledger has rows:

- That the computed boundaries **agree with human judgement**. This is the M0
  gate, and it is unmeasured. Every statement about drip proposing boundaries a
  reviewer would have drawn is currently a hypothesis.
- That **coarsening produces review-sized units a team would accept**, as
  opposed to units of a defensible size.
- That the **review-unit workflow** (docs/review-unit-workflow.md) is better
  than partitioning by hand. It is more checkable — that much is mechanical —
  which is a different claim.

Correctness and usefulness are separate axes here, and only one of them has
been measured. Drip can be entirely correct — every invariant holding, every
check running — and still draw boundaries nobody wants.

## Next validation step

Run the M0 kill gate: three real mega branches, blind hand-drawn partitions,
`drip score --layer atomic`, results recorded above. It is the last ungated
assumption everything else rests on, and it is now a command rather than an
afternoon of reading.

Issue #8's coarsening makes it more tractable than it was when the gate was
first deferred: hand-drawn boundaries are review-sized, and until coarsening
existed drip's output wasn't — so scoring `--layer candidates` in the same
exercise costs one extra flag and answers the more useful question.
