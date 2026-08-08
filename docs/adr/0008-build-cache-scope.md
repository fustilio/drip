# Build-check caching: unchanged stack prefix, not full DAG independence

The plan's M5 goal is "independent slices no longer rebuild each other" (§3.2) — if slice 4 shares no edge with slice 1, editing slice 1 shouldn't force slice 4's build to rerun.

That's not what got built. `materializeSliceCommits` (M1) already chose a single linear commit chain for the whole stack — each slice's commit parents the next, matching the plan's own accepted M5 fallback ("linearise on submit," §8). Under a linear chain, slice 4's materialized tree is genuinely built on top of slice 1's, whether or not they share a symbol edge. So slice 4 *does* need rebuilding whenever anything earlier in the stack changes — skipping it based on DAG edges alone would be a correctness bug, not an optimization, given how materialization actually works today.

What's real and safe under the current architecture: cache a per-slice build result keyed by content hash, and reuse it only for an unbroken *prefix* of the stack that's unchanged since it last passed. The first slice whose content changed, and everything after it, rebuilds; everything before it is skipped. This still delivers the plan's stated payoff for the common case — editing the last slice in a five-slice stack reruns one build, not five — without claiming independence the linear-chain design doesn't actually provide.

True DAG-parallel independent rebuilds would require multi-parent materialization (each slice's tree built only from its own hunks plus its transitive dependencies' hunks, not the full topological prefix) — a bigger change to `materialize.ts` than this milestone's budget covers. Revisit if stacks routinely have late-stack edits that are unrelated to most of what's ahead of them, since that's the case where prefix-caching stops paying for itself.

Building the actual `execSync` calls for the slices that *do* need rebuilding is trivially parallel regardless of this — each already gets its own `git worktree`, so running them concurrently via `Promise.all` needed no architecture change and was free to add alongside the cache.
