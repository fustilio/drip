# drip

A tool for drip-feeding a mega branch back into main as thin, reviewable PRs. Slices are derived projections of the mega branch, not maintained branches.

## Language

**Mega branch**:
The durable source of truth — a git branch containing a coherent but large, unreviewable diff against its target (e.g. `main`). Identified as the input branch diffed against its merge-base with the target.
_Avoid_: feature branch, source branch

**Hunk**:
A single contiguous block of changed lines, as produced by git's own diff algorithm. The atomic unit of clustering — never re-derived or re-split by tree-sitter or any other analysis.
_Avoid_: change, edit, diff block

**Symbol**:
A named, tree-sitter-parseable code entity (function, class, type, etc.) that encloses a given hunk's line range. Used only to look up which symbol a hunk falls inside — tree-sitter is a lookup step, not a hunk-generation step.

**Qualified symbol path**:
A symbol's dot-joined ancestor chain of definition names (e.g. `UserService.getUser`), not just its bare leaf name. Used as the grouping/selector key everywhere identity matters (clustering, overrides) so that two same-named symbols in different scopes never collide. Def-use *reference matching* still searches by leaf name only, since that's how call sites actually refer to a symbol in code.

**Symbol edge**:
A graph edge between two hunks that connects them because they touch the same symbol — including def-use edges, where one hunk modifies a symbol's own definition and the other merely references/calls it without changing it. This is what lets unrelated features sharing a helper collapse into one slice. The basis for clustering hunks into slices.
_Avoid_: dependency, link

**Slice**:
A group of hunks connected by symbol edges, produced by plain connected-components clustering over the symbol-edge graph (no similarity threshold, no weighting). A derived, disposable unit — regenerated from the mega branch, never hand-maintained or rebased.
_Avoid_: chunk, group, PR (a slice is not yet a PR — it becomes one only at the projection step)

**Boundary**:
The edge *between* two slices — i.e., a symbol edge that was *not* absorbed into either slice's internal connectivity. Where drip drew the cut.

**Slice DAG**:
The directed graph of slices, ordered by which slices' symbols are referenced by which other slices. Distinct from the (undirected) symbol-edge graph used to *form* slices — the DAG describes ordering *between* already-formed slices, not intra-slice grouping.

**Ungrouped slice**:
The fallback bucket for hunks tree-sitter can't map to an enclosing symbol (config, markdown, lockfiles, etc.). Not symbol-edged against anything — just a catch-all, excluded from the kill-gate's per-hunk scoring.

**Tree-hash invariant**:
The core correctness check: `apply(slices in topological order) == tree(mega branch)`, verified by comparing git tree hashes.

**Override**:
A durable, human-authored boundary decision — `force_merge` (union two symbol groups into one slice) or `force_split` (pin a symbol group apart, never auto-union with siblings) — keyed by qualified-symbol-path selectors and persisted in `.git/drip.db`. Survives replanning since the plan itself is a disposable cache; the override is the only durable record of "the computed boundary was wrong here."
_Avoid_: exception, rule, hint

**Change-Id**:
A Gerrit-format `Change-Id: I<40-hex>` trailer identifying a logical change across amendments of a mega-branch commit. Assigned only via an explicit opt-in rewrite (`drip plan --assign-ids`), never silently — see `docs/adr/0001-change-id-trailer.md`.
