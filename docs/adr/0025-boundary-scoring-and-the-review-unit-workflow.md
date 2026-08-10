# 0025 — Boundary scoring, and what a review candidate has to state

Status: accepted
Context: issues #15, #16

## Problem

BUILD-PLAN's M0 milestone is built around a question, not a feature:

> **Kill gate:** run against three real mega branches. Are the proposed
> boundaries ones you'd have drawn by hand? **If under two-thirds are, stop.**

Everything after M0 is contingent on the answer, and the answer has never been
produced in a form that can be produced twice. It was an impression formed
while reading a plan — which is exactly the kind of evidence a tool built to
replace impressions has no business running on. Two consequences follow from
that gap, and they are the two issues here:

- **Nothing measures the claim** (#15). "The computed boundaries are ones a
  human would have drawn" is drip's foundational claim, and there is no
  instrument that takes a hand-drawn partition and drip's partition and returns
  a number, let alone the same number twice.
- **Nothing distinguishes a review candidate from a bucket** (#16). The path
  from atomic slices to review units exists — `--coarsen` groups them
  (docs/adr/0017), `--emit-manifest` writes a skeleton, a manifest declares the
  semantic ones (docs/adr/0018) — but a projection could pass every check drip
  had while stating nothing about what change it is. A set of slices with an id
  is what coarsening already produces; the manifest layer exists because the
  *intent* is the thing no graph can derive.

## Decision

### `drip score`: the comparison gets an implementation

A hand-drawn partition is written down as JSON, in the same durable group-key
selectors overrides and manifests already use:

```json
{ "version": 1, "label": "exercise A",
  "units": [{ "id": "auth-refactor", "selectors": ["src/auth.ts::login", "src/auth.ts::logout"] }] }
```

`drip score <branch> --expected <path>` scores drip's partition against it and
exits non-zero below the threshold, which defaults to BUILD-PLAN's two-thirds.

**The metric is boundary agreement under a one-to-one match.** Each hand-drawn
unit is matched to at most one drip unit — greatest overlap first, ties broken
by declaration order then by drip's own topological order, so the matching is
deterministic — and a hunk agrees when it landed in the drip unit its
hand-drawn unit was matched to.

Injectivity is the whole design. A plurality mapping (each hand-drawn unit
scored against whichever drip unit holds most of it) calls "drip merged two
unrelated features into one PR" a perfect result for both of them, which is
precisely the failure the gate exists to catch. Under a one-to-one match, one
unit keeps the drip unit and the other's hunks count as disagreement. Splitting
one hand-drawn unit across three drip units costs the two smaller fragments.
Both directions of being wrong cost something, and both are named separately in
the report — `split across …` and `merged with …` — because a score that can't
say *which* boundary it disagreed about is not usable for fixing anything.

**Three layers, one instrument.** `--layer atomic` scores the slice DAG (the M0
kill gate). `--layer candidates` scores `--coarsen`'s candidate projections.
`--layer manifest` scores the semantic projections in a manifest. Each layer
hands over the units it already produces; scoring has no second opinion about
what drip's partition is. That the same instrument reads all three is what lets
the review-unit workflow be evaluated at the layer that actually claims to
produce review units — a partition can score 50% at the atomic layer and 100%
at the manifest layer, and that difference *is* the measurement of whether the
manifest layer earns its existence.

**Fallback groups are excluded by default.** They are keyed by path rather than
computed from the symbol graph, so scoring them measures the filesystem, not
drip's clustering. `--include-fallback` scores them when the whole partition is
what's being checked.

**Zero scored hunks is a failure, not a pass.** A partition whose selectors
have all vanished usually means it was drawn against a different branch or
base; reporting 0/0 as agreement would be the worst possible answer to give.
Unmatched and duplicated selectors are reported rather than dropped, the same
convention override selectors already follow.

**The material stays out of the repository.** The partition worth scoring
against is somebody's real branch. It is an input file, read from wherever the
caller keeps it; nothing about the exercise is stored in the repo, and the
scorer reads nothing but the file it is given.

### Intent is a validated field

A projection that states no `intent` gets a `no-intent` warning, promoted to an
error by `--require-intent` (and by `--strict`, like every other warning). An
emitted skeleton therefore reports, per projection, exactly which fields are
still the author's: no intent, no verification commands.

Warning rather than error by default, because the skeleton is meant to be
opened and edited, and a tool that refuses to validate its own starting point
is a tool people route around. Error under a flag, because "every PR in this
plan says what change it is" is a property a team should be able to make
non-negotiable in CI — and because a projection whose intent is missing cannot
be reviewed against anything, only read.

## Consequences

- The scoring input is a *partition of selectors*, not of hunks or of files. It
  is written by hand, and a group key is the smallest thing a human can
  reasonably be asked to name.
- The threshold is a flag with a documented default rather than a constant, so
  a team can hold review candidates to a higher bar than the M0 gate without
  redefining the gate.
- `drip score` is read-only and has no GitHub surface. It answers a question
  about a plan, not about a repository's PRs.
- Existing manifests gain warnings they didn't have. Nothing fails that didn't
  fail before, unless `--require-intent` or `--strict` is passed.
- The evaluation method, threshold and outcome ledger live in `docs/validation.md`;
  the workflow this scores lives in `docs/review-unit-workflow.md`.
