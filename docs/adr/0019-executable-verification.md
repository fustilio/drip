# 0019 — Manifest verification is executed, not documented

Status: accepted
Context: issue #10

## Problem

docs/adr/0018 gave each projection a `verification` array. It was metadata:
`validate-plan` printed it, `push --manifest` copied it into the PR body,
nothing ran it.

That is not enough for the thing the manifest exists to promise. A projection
can apply cleanly on its prerequisites *and* reconstruct the mega-branch tree
while still failing its own typecheck or targeted test, because it is missing
operational glue — a generated input, route or module wiring, a fixture, a
config, an import. Applying is not the same as being runnable, and "each PR is
independently runnable" is the entire claim a semantic projection makes.

The existing checks could not catch this. The tree-hash invariant is about the
*whole* set reconstructing the branch. The apply check is about text applying.
Neither executes anything.

## Decision

Verification commands run, and a failure is a hard gate on both
`validate-plan` and `push --manifest`.

Each projection's commands execute in a throwaway worktree checked out at that
projection's own materialized commit — the tree its PR would show. Commands
run from that worktree's root, with the repo's `node_modules` linked in so they
can actually run.

### Against the prerequisite closure, deliberately

Commands run against the **flat-first** materialization: merge-base plus the
projection's transitive prerequisites plus itself. That is what issue #10 asked
for, and it is the meaningful question — "is this PR runnable on the things it
declares it needs".

Under `--projection stacked` the pushed branch additionally contains every
earlier projection, so the tree verified is not byte-identical to the tree
pushed. That is the right trade: the closure check is *stronger* (it fails when
a projection secretly depends on an undeclared sibling, which is precisely the
bug class this exists to catch), and the cumulative chain is already covered by
the per-unit build check in `runVerify`. Flat-first pushes exactly what is
verified.

### Sequential, unlike the per-slice build check

`verifyPerSliceBuild` runs concurrently because it runs a compiler. These run
whatever the manifest author wrote — test suites that bind ports, touch a
scratch database, share fixture directories. Running arbitrary user commands
concurrently trades a real class of flakiness for wall-clock time. The cache is
what keeps reruns cheap instead.

Within a projection, commands stop at the first failure: later commands
normally presuppose the earlier ones passed, so continuing produces cascading
noise rather than new information.

### Cached by tree, and only on success

Cache key is `(branch, projection id, command)`, validated against the tree
hash the command ran on. An unrelated projection moving does not invalidate
anything. Only a **pass** is reusable — a failure always re-runs, so the output
in the report is always from this run. Same convention as the build cache
(docs/adr/0008).

### Deterministic environment, output by path

Commands get `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0` and `DRIP_PROJECTION=<id>`,
so a rerun on the same tree produces the same result and the same captured
text. Output is written to `<gitdir>/drip/verification/<branch>/<id>-<n>.log`
and reported by path — inspectable after the run, never committed, and not
inlined into a CLI report, where a failing suite's output would bury
everything else.

### Opting out is a decision, not a default

An empty `verification` warns unless the projection sets `verificationReason`.
`--strict` promotes every manifest warning to an error, which is the CI knob
(it also catches ordinal selectors). `--no-manifest-check` skips execution
entirely — for local experimentation, never the default, and never implied.

## Consequences

- `validateManifestAgainstGit` returns `{ findings, verification }` rather than
  a bare finding list, so callers can report per-command detail.
- Commands only run once the manifest is structurally sound and every
  projection applies. Running them on a broken graph means every command fails
  for the same upstream reason and the report buries the real cause.
- `validate-plan` is no longer side-effect-free in the ordinary sense: it runs
  the manifest's commands. It still touches no branches and no PRs, and the
  MCP tool's description says so plainly.
- The worktree/symlink/cleanup dance is now `withWorktree` in `verify.ts`,
  shared with the per-slice build check rather than copied.
