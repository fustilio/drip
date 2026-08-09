# 0015 — Fallback grouping replaces the single `ungrouped` slice

Status: accepted
Context: issue #7

## Problem

Every hunk tree-sitter couldn't map to an enclosing symbol went into one
global `ungrouped` slice. On a real 55-commit TypeScript branch that bucket
was 170 hunks across 48 files with 25 prerequisites — lockfiles, package
manifests, `.gitignore`, backend integration tests and seeds, frontend tests,
route wiring, docs/ADRs, shared types and configuration, all in one
projection. It was simultaneously the largest PR in the plan and the one with
the least review meaning.

The bucket also had no identity: its slice signature was the multiset of
`file::?` placeholders, so it changed whenever any unrelated non-symbol file
entered or left the diff.

## Decision

There is no global fallback bucket. Each unassigned hunk gets a deterministic
fallback group key derived from its path alone:

- **`<dir>/package.json::(deps)`** for a package manifest or its lockfile.
  A lockfile churn is never independently reviewable from the manifest change
  that caused it, so they share one group whether or not both actually changed.
- **`<path>::(file)`** for everything else — one group per file.

The `path::selector` shape is deliberate: it is exactly the selector format
`drip override add` already takes (docs/adr/0004), so fallback groups go
through the *same* union-find and the *same* `force_merge`/`force_split`
mechanism as symbol groups. No second override system, no projection-only
concept. `drip override add --kind force_merge --selector-a
"README.md::(file)" --selector-b "app.ts::load"` works.

Each unassigned hunk also carries the reason it is unassigned —
`dependency-manifest`, `unsupported-language`, `unparseable`, or
`no-enclosing-symbol` — surfaced per hunk and per group in both the text plan
and `--json`. Unassigned hunks are now an actionable diagnostics list, not a
silent catch-all.

## Consequences

- Slice signatures (docs/adr/0006) now use the planner's own group key for
  every hunk, not `file::?` for unassigned ones. Fallback groups therefore
  have stable correspondence across replans. Existing correspondence rows for
  the old single `ungrouped` slice are orphaned once — unavoidable, and the
  old key was never stable enough to be worth preserving.
- Fallback groups are never *definers* in the def-use graph (they have no
  symbol), so no edge ever points at one. They cannot participate in a cycle.
- A top-level `import` hunk still lands in its file's fallback group rather
  than with the symbol that needs the import. That can make a symbol slice
  fail its standalone build check — correctly reported, not hidden. Absorbing
  top-level hunks into a same-file symbol slice is coarsening, and belongs to
  the projection stage (docs/adr/0016), not to hunk assignment.
