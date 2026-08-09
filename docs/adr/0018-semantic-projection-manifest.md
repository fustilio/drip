# 0018 — Semantic projection manifest

Status: accepted
Context: issue #9

## Problem

Symbol slicing is a good atomic substrate and a bad source of human review
units. After fallback grouping (docs/adr/0015), a 55-commit appeals branch
produced **161 atomic slices**, and `--coarsen --target-slices 12` met the
count by folding 149 of them into one projection. Neither output is
reviewable.

Two distinct failures, and it matters which is which:

1. **A defect in coarsening's budget pass** — it always merged into a bucket's
   first member, so a budget was met by growing one runaway projection. Fixed
   here (pair the two smallest, cap any projection at twice its fair share, and
   report the budget as unmet rather than degenerate).
2. **A limit of the whole approach** — even a perfectly balanced automatic
   grouping doesn't recover "the report-tab detail experience". That boundary
   is a statement about product intent. No graph heuristic over symbol edges
   has access to it.

The missing layer is not another heuristic. It's an explicit, durable record
of intent that drip validates rather than derives.

## Decision

A versioned JSON manifest, passed explicitly to `drip validate-plan` or
`drip push --manifest`. Something outside drip — an agent, a human, both —
proposes it from `plan --json`; drip owns validation and materialization and
nothing else. Same boundary as docs/adr/0009: no AI inside the binary.

The manifest is inert until passed. It is never read implicitly, never
auto-discovered, and never written by drip.

### Members are selectors, not ordinals

`slice17` is derived and renumbers whenever the branch changes, so a manifest
written in ordinals is stale on the next replan. Members are therefore group
keys — `src/appeals/report.ts::renderReport`, `README.md::(file)` — the same
durable selectors overrides already use (docs/adr/0004, docs/adr/0015).

Ordinals are still *accepted*, because they're what `plan` prints and what an
agent reaches for first, but each one earns a warning naming the durable
selector to use instead. Accepting them silently would let a manifest rot
invisibly; rejecting them outright would make the format hostile to write.

### Correspondence identity is the projection id

A projection's PR is keyed on `manifest:<id>` — the approved semantic
boundary — not on a hash of the atomic slices it currently contains. That is
the point of the layer: the slices underneath `report-tab-details` can be
resliced, renumbered, split and merged, and the PR keeps its identity, its
review comments and its history. This is the first identity in drip that is
genuinely durable rather than an intermediate stand-in (contrast
docs/adr/0006).

### What gets validated

Deterministically, with no heuristics:

- Every atomic slice assigned exactly once, or explicitly deferred **with a
  reason**.
- No projection depends on a deferred slice.
- The manifest's `dependsOn` graph is acyclic.
- Every atomic edge crossing a projection boundary is covered by the manifest's
  transitive `dependsOn`. A dependency may be **widened** but never dropped —
  an atomic edge was discovered from the code itself.
- Each projection applies on its declared prerequisite closure (reusing
  flat-first materialization from docs/adr/0016, which already answers exactly
  this question).
- Shared glue lives in an ancestor of every projection referencing it.
- Review budgets (files, hunks, changed lines), overridable only with an
  explicit `oversizeReason`.
- The whole graph reconstructs the mega-branch tree hash.

### Glue is a reference, not a claim

A projection often needs a small non-feature change to stay buildable: an
import, a DTO field, a fixture, a route registration. Forcing those into a
generic "shared foundation" PR is what makes stacks unreviewable, and leaving
them out produces broken intermediate PRs.

So `glue` is a *reference*: several projections may each declare they need the
same small change. It is assigned once — to an explicit `atomicSlices`
assignment if there is one, else to the first referencing projection — and
every other referencing projection must have that owner in its prerequisite
closure. Glue is counted and displayed separately so a reviewer can see what
is feature and what is scaffolding.

### Deferral is checked, not waived

Deferred slices are excluded from the pushed projections but **included** in
the tree-hash check, as a trailing remainder unit. Checking the projections
alone would have forced a choice between failing every manifest that defers
anything and downgrading the one check that proves nothing was silently lost.
Appending the remainder keeps it a hard check: deferral decides which PR
something lands in, never whether it exists.

## Consequences

- `push` now iterates `PushUnits` — atomic slices by default, manifest
  projections when supplied. Both go through the same squash-merge detection,
  correspondence, interdiff and comment-reconciliation path; there is no
  parallel manifest push implementation to drift.
- `push --manifest` validates first and refuses on any error. Pushing an
  incoherent manifest is worse than not pushing.
- Verification runs against whatever `push` will materialize — atomic slices,
  coarsened projections, or manifest projections — never against something
  else.
- Manifest storage has a convention, not a requirement. With no `--manifest`,
  `validate-plan` looks in `.drip/projections/<branch>.json` (tracked, and
  first on purpose — unlike overrides, an approved review plan is a document a
  team argues about, reviews and keeps, so it does not belong in
  `.git/drip.db`) and then `<gitdir>/drip/projections/<branch>.json` for the
  solo case. `plan --coarsen --emit-manifest` writes a valid skeleton there,
  refusing to overwrite without `--force`.
- **`push` deliberately does not auto-discover.** A stale manifest sitting in
  the conventional location must never silently change what `push --yes` sends
  to GitHub — the `--yes` gate confirms "push", not "push these projections
  rather than these slices". So push requires the flag, and prints a notice
  when a manifest exists that it is not using. Staying silent would be its own
  trap; discovering it would be worse.
- The emitted skeleton has mechanical ids and **no `intent`**. Inventing
  product intent is precisely what drip has no basis to do, and a placeholder
  would end up in a real PR body. It exists so the author edits a valid,
  complete file rather than hand-writing selectors.
