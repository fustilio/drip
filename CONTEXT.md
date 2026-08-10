# drip

A tool for drip-feeding a mega branch back into main as thin, reviewable PRs. Slices are derived projections of the mega branch, not maintained branches.

## Language

**Mega branch**:
The durable source of truth — a git branch containing a coherent but large, unreviewable diff against its target (e.g. `main`). Identified as the input branch diffed against its merge-base with the target.
_Avoid_: feature branch, source branch

**Diff source**:
Where a plan's "after" state is read from — a tree-ish, nothing more. Normally the mega branch itself; under `--worktree`, a tree built from the working tree (staged, unstaged and untracked) in a scratch index, so a change can be partitioned before the commits that would make it reviewable exist. Always base-relative either way: committed branch work and uncommitted edits are one change to slice. The *identity* of the plan stays the branch — overrides, correspondence and manifests key off that, not off the tree. Reported on every run, never inferred. See docs/adr/0021.
_Avoid_: input, working copy, staging

**Excluded section**:
A diff section drip cannot turn into hunks — binary, pure rename, mode-only, an empty file creation — and which therefore appears in no slice. Reported with its path and reason, and named again in any tree-hash failure, since a section that's in the diff and in no slice guarantees the mismatch on its own.
_Avoid_: skipped file, unsupported (both hide that the change is still real)

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

**Reviewable stack**:
A PR graph in which every base is a branch that has a PR on it. `--projection flat-first`'s generated integration base breaks that: it unions several prerequisites into a minted branch with no PR, so reviewers can't walk the prerequisites and a workflow filtered on the base branch never runs. Always reported; refused outright under `push --reviewable-stack`, whose remedy is to merge those prerequisites into one projection or declare one they all sit under. See docs/adr/0023.
_Avoid_: stack (bare — `--projection stacked` is a different axis entirely)

**Runnable check**:
A command that was actually executed against a projection's own materialized tree. Distinct from a stated intention: `verificationReason` records a decision not to check, and under `--require-verification` that decision may not cover a projection containing code. drip only ever runs a check the repository named for itself — a root `tsconfig.json`, a root `typecheck` script, or a manifest `verification` entry — and merely *offers* the per-package scripts it discovers, since composing a workspace invocation and then failing someone's push on the result is a guess with consequences. See docs/adr/0023.
_Avoid_: build check (that's the per-slice compiler run specifically), CI

**Verification profile**:
A named set of verification commands declared once for the repository, in `.drip/verification.json` (or the private `<gitdir>/drip/verification.json`), that a projection references by name instead of repeating the strings. Resolution is a lookup and never a merge — declaring both a profile and inline `verification` commands is an error, not a precedence rule — and the resolved commands are what runs, what `--require-verification` counts and what the PR body carries. drip never selects one for you: no default, no inference from the workspace. Reported next to the commands it produced, so what runs is never one file away. See docs/adr/0024.
_Avoid_: preset, config (a profile names commands the repository already runs; it decides nothing)

**Intent**:
The sentence a projection states about what behavioural change it is — the thing a reviewer holds the diff against. The one field no layer below the manifest can produce: a projection without it is a set of slices with an id, which is what coarsening already gives you. Missing intent is a `no-intent` warning, an error under `--require-intent` or `--strict`. See docs/adr/0025.
_Avoid_: description, summary (both invite restating the diff — "changes to report.ts" is not an intent)

**Hand-drawn partition**:
The grouping a human would have drawn, written down before looking at drip's output, as a versioned JSON file of unit ids and durable group-key selectors. The input to scoring, and deliberately not a repository artifact — the material worth scoring against is somebody's real branch, so the file lives wherever that branch does. Blind is load-bearing: a partition drawn after reading the plan measures how persuasive the plan is, not how right it is.
_Avoid_: ground truth (it is one informed opinion, which is exactly what the gate asks about), expected output

**Boundary agreement**:
What `drip score` measures: the fraction of scored hunks that landed in the drip unit their hand-drawn unit was matched to, under a **one-to-one** match between hand-drawn and drip units. Injective on purpose — a plurality match would score "drip merged two features into one PR" as a perfect result for both, which is the failure the M0 kill gate exists to catch. Splits and merges each cost something and are named separately, and every disagreement is reported by selector. Fallback groups are excluded unless asked for. The gate is BUILD-PLAN's two-thirds; the layer (`atomic`, `candidates`, `manifest`) says which of drip's partitions is being scored. See docs/adr/0025 and docs/validation.md.
_Avoid_: accuracy, score (bare — always say which layer and which threshold)

**Adoption candidate**:
An open PR whose branch, replayed onto the mega branch's merge base, produces exactly the tree a projection materializes — the same evidence `manifest adopt` requires, found for you instead of by you. Reported with the exact adopt command to review and run, never acted on. A branch carrying a projection's own change but not its prerequisite closure is a candidate of a different, named kind (`own-change-only`), because that shape reads identically to "wrong PR" in a raw diff and means something else entirely. Titles, branch names and authorship are never evidence. See docs/adr/0026.
_Avoid_: match, suggestion (both imply drip has an opinion; it has a tree comparison)

**Review context**:
The joined, read-only view of one projection's review surface: its identity and intent, the branch and PR it corresponds to (and whether drip opened that or adopted someone else's), whether the recorded base still agrees with the manifest graph, whether the projection's content has moved since its PR last received it — with the selectors that moved — and the open threads on it. Read-only is a property of the code, not a promise: nothing in that path comments, replies, resolves, pushes or records, and the suite asserts it. What it cannot know it says: thread *resolution* state isn't exposed by the endpoint drip reads. See docs/adr/0027.
_Avoid_: review state (implies drip knows whether threads are resolved — it doesn't), status

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

**Materialization**:
Turning a slice or projection into real git objects: applying its hunks onto a parent tree in a scratch index and committing the result. Always the same code, wherever it's needed — the tree-hash check, the per-slice build check, `manifest adopt`'s comparison, `push`, and `drip materialize` all call it rather than each having a notion of what a projection's commit is. *Local* materialization (`drip materialize`) stops there: refs under `drip/<branch>/<id>` and optional worktrees, no remote ref, no PR, no correspondence recorded. See docs/adr/0022.
_Avoid_: build, generate, export

**Adoption**:
Binding a semantic projection to a PR and branch that already existed — handwritten, with its own reviewers, comments and name — instead of opening a drip-owned one. Explicit and evidence-based: `drip manifest adopt` takes the projection id, PR number and head branch, and records correspondence only after the branch's effective diff, replayed onto the mega branch's merge base, produces exactly the projection's materialized tree. Never inferred from titles or similarity, never pushes anything, and leaves an adopted branch under lease afterwards — drip doesn't own it. See docs/adr/0020.
_Avoid_: import, claim, takeover

**Slice signature**:
A slice's identity key for correspondence purposes in M2: the sorted, joined list of group keys the slice unions together — `file::QualifiedSymbolPath` for symbol groups, the fallback selector for fallback groups. An intermediate stand-in for real content-addressing (M3) — see `docs/adr/0006-slice-correspondence-key.md`.
