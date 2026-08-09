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

**Fallback group**:
A slice formed from hunks tree-sitter can't map to an enclosing symbol (config, markdown, lockfiles, top-level imports). Keyed deterministically by path — `<path>::(file)`, or `<dir>/package.json::(deps)` for a manifest and its lockfile — so it clusters and takes overrides through exactly the same machinery as a symbol group, and its identity survives replanning. Never a *definer* in the def-use graph, so no edge ever points at one. Each carries the reason it's unassigned (`dependency-manifest`, `unsupported-language`, `unparseable`, `no-enclosing-symbol`). Excluded from the kill-gate's per-hunk scoring.
_Avoid_: ungrouped slice (there is no longer one global bucket — see docs/adr/0015), catch-all

**Projection**:
What a slice becomes when it's turned into something GitHub can show: a branch and a PR. Three independent axes. *Which* slices are reviewed together is either `--coarsen`'s **candidate projection** — a review-sized group derived by deterministic rules (docs/adr/0017) — or a **semantic projection**, declared in a manifest because it encodes product intent no graph can derive (docs/adr/0018). *What each branch is built on* is `push --projection`'s mode: `stacked` chains every PR onto the previous slice's branch, `flat-first` picks each base from the DAG so independent slices target the base branch directly (docs/adr/0016).
_Avoid_: using "projection" bare when the coarsening/manifest/base-selection distinction matters

**Manifest**:
A versioned JSON document declaring the semantic projections for a mega branch: each one's id, intent, member slices, glue, prerequisites and verification commands. Proposed by something *outside* drip (an agent reading `plan --json`, a human, both); drip only validates and materializes it. Inert until explicitly passed to `validate-plan` or `push --manifest` — never auto-discovered, never written by drip, and deliberately a file rather than a row in `.git/drip.db`, since an approved review plan is a document a team wants to diff and commit. See docs/adr/0018.
_Avoid_: config, plan file (the *plan* is the derived atomic slice DAG — the manifest is the approved grouping over it)

**Glue**:
A small non-feature change a projection needs to stay buildable and testable: an import, a DTO field, a fixture, a route registration, a compatibility guard. Declared as a *reference*, not an exclusive claim — several projections may each need the same one, in which case it's assigned once and every other referrer must have that owner in its prerequisite closure. Exists so a projection doesn't have to choose between a generic shared-foundation PR and a broken intermediate PR.

**Defer**:
An explicit decision that an atomic slice lands in no projection *for now*, recorded with a reason. Deferred slices are excluded from what's pushed but still included in the tree-hash check, so deferral decides which PR something lands in and never whether it survives.

**Tree-hash invariant**:
The core correctness check: `apply(slices in topological order) == tree(mega branch)`, verified by comparing git tree hashes.

**Override**:
A durable, human-authored boundary decision — `force_merge` (union two symbol groups into one slice) or `force_split` (pin a symbol group apart, never auto-union with siblings) — keyed by qualified-symbol-path selectors and persisted in `.git/drip.db`. Survives replanning since the plan itself is a disposable cache; the override is the only durable record of "the computed boundary was wrong here."
_Avoid_: exception, rule, hint

**Change-Id**:
A Gerrit-format `Change-Id: I<40-hex>` trailer identifying a logical change across amendments of a mega-branch commit. Assigned only via an explicit opt-in rewrite (`drip plan --assign-ids`), never silently — see `docs/adr/0001-change-id-trailer.md`.

**Correspondence**:
The durable link between a slice and its projection — `slice branch ↔ PR number/URL` — persisted in `.git/drip.db` so `drip push` updates an existing PR instead of opening a duplicate on every run. Keyed by slice signature, not the slice itself (slices are recomputed, disposable; correspondence is what survives).

**--json**:
`drip plan`'s machine-readable output mode: slices, files, symbols, hunk ranges, edges, and unmatched override selectors as a single JSON object on stdout, nothing else. The intended interface for external tools (agents, scripts) to read ambiguous-boundary/naming context and write decisions back through `drip override add` — see `docs/adr/0009-ai-integration-external-not-bundled.md` for why this replaced the plan's originally-scoped bundled `--ai` flag.

**Anchor**:
The link between a review comment and the code it refers to, used to survive force-push regeneration. M4 anchors on exact hunk hash only (`sha1` of the hunk's raw patch text) — see `docs/adr/0007-comment-anchor-scope.md` for why the plan's symbol-path and fuzzy tiers aren't built yet. A comment whose hunk hash no longer appears in the new push is orphaned with a loud reply on its thread, never silently dropped.
_Avoid_: link, mapping, reference

**Adoption**:
Binding a semantic projection to a PR and branch that already existed — handwritten, with its own reviewers, comments and name — instead of opening a drip-owned one. Explicit and evidence-based: `drip manifest adopt` takes the projection id, PR number and head branch, and records correspondence only after the branch's effective diff, replayed onto the mega branch's merge base, produces exactly the projection's materialized tree. Never inferred from titles or similarity, never pushes anything, and leaves an adopted branch under lease afterwards — drip doesn't own it. See docs/adr/0020.
_Avoid_: import, claim, takeover

**Slice signature**:
A slice's identity key for correspondence purposes in M2: the sorted, joined list of group keys the slice unions together — `file::QualifiedSymbolPath` for symbol groups, the fallback selector for fallback groups. An intermediate stand-in for real content-addressing (M3) — see `docs/adr/0006-slice-correspondence-key.md`.
