# 0017 — Review-sized coarsening above the atomic slice DAG

Status: accepted
Context: issue #8

## Problem

Connected components over symbol edges produce technically isolated slices,
but a symbol is rarely a PR boundary. A real 55-commit branch produced 114
slices — mostly one symbol in one file: a component, a helper, a DTO, a
service method, a test renderer, a UI primitive. The meaningful review units
were closer to six: report-tab detail, past-appeals, inbox columns, the
outstanding-offender query refactor, the reply/closure workflow, and broad
typography work.

The slice DAG was right about technical ordering and wrong as a direct PR
plan. Getting from 114 micro-slices to six product changes was left entirely
to the human.

## Decision

A coarsening stage that sits *above* the atomic slice DAG, in `src/coarsen.ts`,
reached by `drip plan --coarsen` / `drip verify --coarsen`. It never
re-derives, re-splits or reorders hunks — it only decides which atomic slices
are reviewed together. The atomic DAG stays the source of truth, and
`--coarsen` is an optional planning mode, never a replacement for it.

Four deterministic, non-AI rules, applied in this order:

1. **`same-file`** — a file's top-level hunks (its fallback group, reason
   `no-enclosing-symbol`) join that file's own symbol slice when the file has
   exactly one. This is what stops a symbol slice from failing its own build
   check for an import sitting in a different projection (docs/adr/0015).
2. **`test-affinity`** — a test-only slice joins the production slice it
   exercises: by filename relation (`foo.test.ts` → `foo.ts`) first, since
   that one is unambiguous, then by a sole non-test prerequisite.
3. **`sole-consumer`** — a slice referenced by exactly one other slice has no
   separate audience; reviewing it alone means reviewing a definition with no
   call site. Fallback groups are exempt: a lockfile or docs change with one
   consumer is still its own reviewable thing.
4. **`directory-affinity`** — budget-driven only, under `--target-slices N`.
   Merges projections sharing a directory prefix, deepest directory first,
   one pair at a time, until the budget is met. "Everything under this feature
   directory is one PR" is a reasonable last resort for hitting a review-size
   target and a bad default, so it never runs without an explicit budget.

Dependency manifests and unsupported-language files (docs, config) are held
out of directory merging entirely — they stay separate projections unless an
override joins them.

## Overrides: the existing mechanism, not a second one

`force_split` means "this must stay independently reviewable". A projection
holding a force_split-pinned group is never merged, as source or target, and
is reported `pinned`. A `--target-slices` budget that could only be met by
merging one is reported as **unmet** rather than quietly overruling a durable
human decision.

There is deliberately no projection-level override table. `force_merge` and
`force_split` already act on group-key selectors, fallback groups included
(docs/adr/0015), so they shape the atomic slices the projections are built
from. A second durable mechanism keyed on projections — which are derived and
renumber freely — would be a worse version of the one that already exists.

Each projection still carries a content-derived `signature` (the hash of its
constituent group keys, same principle as docs/adr/0006) so it can be
referenced across replans despite renumbering.

## Cycles

Merging two nodes of a DAG can introduce a cycle: if `A → C → B`, then
`{A,B}` is both before and after `C`. Every candidate merge is applied and the
quotient graph re-topo-sorted; a merge that breaks acyclicity is undone. `n`
is a few hundred at most, and "did this stay a DAG" is exactly the question
being asked — a reachability argument would be a second implementation of
topological sorting with its own bugs.

## Verification

`verify --coarsen` needed no new verifier. A coarsened plan is presented in
the shape `verify` already consumes — one "slice" per projection, in
projection-topological order (`projectedUnits` in `workflow.ts`) — so the
same tree-hash invariant proves the coarsened projection reconstructs the
mega-branch tree, and the same per-projection build check runs against it.

## Not done

`drip push` still materializes atomic slices; `--coarsen` is rejected there
rather than silently verifying one thing and pushing another. Pushing
projections is the obvious follow-up, and is not what issue #8 asked for.
