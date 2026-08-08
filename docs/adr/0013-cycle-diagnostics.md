# Surface cycle diagnostics instead of a bare "dependency cycle" error

`plan --json` and `plan`'s text output used to collapse a cyclic slice DAG into `{ ok: false, error: "dependency cycle in slice DAG" }` (or one line of `console.error` in text mode) with no further detail (GitHub issue #3). A user hitting this had no way to tell which slices were involved, which symbol references caused it, or whether it was a real indivisible mutual dependency vs. a false-positive edge from the def-use matcher's name-only regex (`planner.ts`, a known limitation — see STATUS.md).

Fixed by computing strongly-connected components (Tarjan's algorithm, `findCycles` in `planner.ts`) over the slice edge graph whenever `topoSort` returns `null`, and reporting, per cycle:

- the member slice IDs
- the participating edges, each with **evidence**: the symbol name, and the file/line range on both the referencing and the defining side
- any existing override (`force_merge`/`force_split`) whose selector already touches a symbol in the cycle — a hint that the fix might already be one `drip override add` away

This required two supporting changes:
1. Edge evidence (previously discarded — the def-use matching loop only recorded the existence of an edge, not why) is now retained per edge in `PlanResult.edgeEvidence`.
2. Slice numbering (`idToNum`) no longer requires a successful topological sort — it falls back to first-seen-in-diff order so cyclic plans still get stable, referenceable `sliceN` labels for diagnostics.

Scope, matching the issue: diagnostics only. No automatic cycle-breaking, no weakened verification — `plan.order` is still `null` on a cycle, and `drip verify`/`drip push` still refuse to proceed past it.
