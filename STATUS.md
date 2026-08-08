# Status

Tracks reality against `BUILD-PLAN.md`. Update this, not the plan doc — the plan is the original intent, this is what actually exists.

## Milestones

| Milestone | State | Notes |
|---|---|---|
| M0 — feasibility spike | Built, **kill-gate not run** | `m0.ts`. Works, but the actual gate (blind hand-drawn boundaries vs. drip's output, ≥⅔ per-hunk match on 3 real branches) has never been scored — user deliberately proceeded past it to keep building. Everything below rests on an ungated M0. |
| M1 — planner + verifier | Built, hardened | `src/{git-backend,planner,store,change-id,verify,cli,errors}.ts`. `drip plan`/`drip verify`, SQLite overrides, Change-Id trailers, per-slice `tsc` build check, override CLI, `--timing`, clean user-facing errors, unit tests (`bun test`). |
| M2 — push/PR | Built, verified live | `src/{materialize,github,push}.ts`. `drip push` — stacked branches/PRs via `gh`, correspondence tracking (symbol-signature keyed, not content-hash — that's M3), `--yes`/`--dry-run` safety gate. Tested end-to-end against `drip-dummy`: 5 PRs created, correctly stacked, idempotent re-run, then closed/deleted as cleanup. |
| M3 — regeneration/reconciliation | Built, verified live | `src/push.ts` (+`git-backend.ts` `applyCachedReverseCheck`, `github.ts` `ghPrComment`/`ghPrClose`, `store.ts` `content_hash`/`commit_sha` columns). Content-addressed skip (unchanged slice → no force-push), squash-merge detection (reverse-apply-check against base branch tip → drop slice, close its PR), interdiff posted as a PR comment on content change. Slice identity is still the symbol signature from M2, not a diff hash — see `docs/adr/0006`; content hash is used for the skip/interdiff decision, not correspondence identity itself. |
| M4 — comment anchoring | Built (conservative cut), verified live | `src/anchors.ts` (+`github.ts` `ghListReviewComments`/`ghReplyToReviewComment`, `store.ts` `comment_anchors` table). Tier 1 only (exact hunk-hash match) — symbol-path and fuzzy/AI tiers deliberately deferred, see `docs/adr/0007-comment-anchor-scope.md`. On every content-changing `push` to an existing PR, review comments on touched files get checked against the old vs. new hunk hash: unchanged hash → left alone, anything else → a loud reply on the original thread, never a silent drop. |
| M5 — DAG parallelism + AI | Built, verified live. AI half deliberately re-scoped from the plan's original shape. | `src/verify.ts`, `src/signature.ts` (+`store.ts` `build_cache` table). Per-slice build results are cached by content hash and reused for an unbroken unchanged *prefix* of the stack — not full DAG independence, see `docs/adr/0008-build-cache-scope.md` for why (the stack is a single linear commit chain, so a later slice's build genuinely depends on everything before it). Slices that do need rebuilding run concurrently via `Promise.all` since each already gets its own git worktree. **Scope change on the AI half** (user call, see `docs/adr/0009`): no bundled provider integration, no `--ai` flag. Instead `drip plan --json` exposes the ambiguous-boundary/naming context in machine-readable form, and `src/mcp.ts` (`drip mcp`) wraps `drip_plan`/`drip_verify`/`drip_override_{add,list,remove}` as MCP tools — so any MCP client or JSON-consuming agent can propose decisions and write them back through the existing override mechanism, with zero AI provider or API key inside drip's own process. |

## What's verified, not just written

- Tree-hash invariant: passes on the dummy fixture, holds under branch regeneration (new commits added later), unaffected by `main` advancing independently, and survives a deliberately out-of-textual-order `git apply` (hoisted def-use, `feature2` branch).
- Per-slice build check: catches a real intentional type error, correctly propagates failure to downstream-dependent slices, passes clean otherwise.
- Change-Id assignment: idempotent (no-op on unchanged commits), preserves original author identity, only changes what actually needs a trailer.
- Overrides: `force_merge` combines independently-computed slices, `force_split` no-ops safely, unmatched selectors get reported not silently dropped.
- Push: real PRs opened and correctly stacked (verified via `gh pr view` on each), idempotent re-run (still 5 PRs, not 10), `--dry-run` has zero side effects (checked via `git ls-remote`).
- Cycle detection: a genuine mutually-recursive cross-file edit case (`planner.test.ts`) correctly returns `order: null` instead of silently mis-ordering — this had never been exercised before the test existed.
- M3 reconciliation: live-tested against `drip-dummy` by simulating a squash-merge (applying one slice's patch directly to `main`) and a content edit on another slice's already-pushed branch. Result: the squash-merged slice was dropped and its PR closed automatically, the edited slice got `[updated]` with a real interdiff comment, and the three untouched slices correctly reported `[unchanged]` with zero force-pushes.
- M4 comment anchoring: live-tested against `drip-dummy` by posting a real GitHub review comment on a slice's PR, then editing that exact hunk and re-pushing. The comment got a loud "couldn't be confidently relocated" reply threaded on the original thread. Re-running `push` again with no further changes did not double-reply — confirmed idempotent via `gh api` comment count staying at 2.
- M5 build-cache: verified against `drip-dummy` — a clean `verify` run followed immediately by a second reported `5 cached, 0 rebuilt`; editing only the last slice in the stack and re-running reported `4 cached` (only the changed slice rebuilt), confirming the prefix-skip logic and not a blanket full-rebuild or blanket full-skip.
- `drip plan --json`: verified against `drip-dummy` — output is valid, parseable JSON with zero stray prose on stdout (piped through both a Python and a Node one-liner to confirm), matches the human-readable plan's slice/edge/symbol data.
- `drip mcp`: verified end-to-end against `drip-dummy` using a real MCP client (`@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`, spawning `drip mcp` as a subprocess) — all five tools exercised: `drip_plan`, `drip_verify` (tree + build check both passed), `drip_override_add` → `drip_override_list` (entry appeared) → `drip_override_remove` → `drip_override_list` again (entry gone). A raw hand-written JSON-RPC-over-stdin smoke test was tried first and looked broken (the `tools/call` response never arrived) — turned out to be a timing artifact of piping a static file into stdin rather than a real bug; the proper SDK client round-tripped cleanly on the first try.

## Known limitations (accepted, not bugs)

- Slice correspondence (M2) is keyed by symbol composition, not diff content — see `docs/adr/0006`. A slice whose touched symbols change identity loses its PR link.
- Def-use edges are name-only regex matching, not scope-aware reference resolution (`planner.ts`, flagged inline).
- Override selectors break silently on symbol rename/move — no fuzzy relocation until M4's anchor system (`docs/adr/0004`).
- `git apply` per-slice ordering has only been tested against well-separated hunks with unique context; a pathological near-duplicate-context case could still trip fuzzy matching.
- Squash-merge detection is a reverse-apply-check against the base branch's current tip, not real content-addressing — it can false-negative (fail to detect) if surrounding context drifted, but won't false-positive silently drop a slice that wasn't actually merged (a failed reverse-apply just means "not detected," the slice still pushes normally).
- Comment anchoring only reconciles on pushes where the slice's content actually changed (piggybacks on the M3 content-hash check) — a comment posted on a slice that never gets touched again is never checked, which is fine (nothing to reconcile), but a comment posted then immediately squash-merged away is never reconciled either since squash-merged slices skip the push path entirely.
- Only top-level, right-side (`side: RIGHT`) review comments are considered; left-side (deleted-line) comments and thread replies are silently skipped rather than reconciled — see `docs/adr/0007`.
- Build-cache skip is prefix-based, not true DAG-independence — see `docs/adr/0008`. An edit near the *start* of the stack still forces a full rebuild of everything after it, even slices with no real relationship to the edit.

## Architecture review

Ran `/improve-codebase-architecture` after all milestones were built. Four candidates identified, all four walked via `/grilling` and shipped:

- **Unify plan/verify orchestration** (`src/workflow.ts`) — `cli.ts` and `mcp.ts` had each reimplemented the merge-base → store → computePlan → tree-hash → build-check workflow, and had already drifted (mcp.ts's override-add was missing a validation check cli.ts had). One `loadPlan`/`runVerify`, two thin formatters.
- **Collapse a duplicate patch-builder** — `verifyTreeHash` re-derived what `buildSlicePatch` (materialize.ts) already did. Now calls it.
- **`classifySliceStatus`** (`src/push.ts`) — pulled the five-way slice-status decision (created/updated/unchanged/squash-merged/dry-run) out of `push()`'s loop as a pure function; the loop is now a thin shell acting on the result. Unit tested.
- **Test the orchestration paths** — not a `FakeGitBackend` as originally proposed (reframed after grilling: faking git's object model is riskier than the thing it'd test). Instead: `src/test-helpers.ts` extends the real-temp-git-repo pattern `planner.test.ts` already used, to `verify.test.ts` (build-cache prefix-skip) and `push.test.ts` (status-to-side-effect wiring, real `git push` to a local bare remote, only `github.ts`/`anchors.ts` mocked since GitHub's API is the actual untestable-with-real-git boundary). See `docs/adr/0010`.

Test count: 4 → 15 across 3 files. `docs/adr/0009` and `0010` record the two decisions where the "obvious" fix (bundle an AI provider; build a FakeGitBackend) was reframed after grilling into something that fit the project's own existing conventions better.

## Bugs found via real usage (GitHub issues #1, #2), fixed

- **Worktree support** (issue #1) — `openStore` hardcoded `<repoRoot>/.git/drip.db`, which broke in linked worktrees (`.git` is a pointer file there, not a directory). Fixed via `git rev-parse --git-path drip.db`, which resolves to the worktree's private gitdir — see `docs/adr/0011-drip-db-location.md`. Regression test: `src/store.test.ts`.
- **Global-install WASM resolution** (issue #2) — grammar `.wasm` paths were resolved relative to CWD (the target repo being planned), so a globally-installed `drip` only worked if the target repo happened to have drip's own tree-sitter deps installed. Fixed via `createRequire(import.meta.url).resolve(...)`, resolving relative to drip's own install location instead — see `docs/adr/0012-wasm-asset-resolution.md`. Not yet covered: a `bun build --compile` single-binary distribution (no `node_modules` to resolve into at all) — flagged, not fixed, out of scope for this pass.
- **Cycle diagnostics** (issue #3) — a cyclic slice DAG used to collapse to a bare `"dependency cycle in slice DAG"` error with no detail. `plan`/`plan --json` (and `drip_plan`/`drip_verify` over MCP) now report each strongly-connected component: member slices, participating edges with symbol/file/line evidence on both sides, and any existing override already touching the cycle. Diagnostics only — no auto cycle-breaking, `plan.order` is still `null` and `verify`/`push` still refuse to proceed. See `docs/adr/0013-cycle-diagnostics.md`.
- **Def-use false cycles** (issues #4, #5) — two shapes of false cross-file edge in the name-only def-use matcher. (4) Every changed constructor's own declaration contains the literal word `constructor`, so any two changed constructors always false-matched each other regardless of actual usage — fixed by keying constructors by their enclosing class name instead. (5) Same-named unexported local helpers in different files (e.g. `renderSection` in two test files) created a spurious cross-file edge — fixed by gating cross-file def-use matches on the definition being `export`ed; same-file matching is unaffected. See `docs/adr/0014-def-use-edge-precision.md`.

## Gotchas hit during this build (so they don't get rediscovered)

- Bun's `execFileSync` inherits stderr live by default, unlike Node's pure pipe-and-capture — every git failure double-printed raw `fatal: ...` noise until `stdio: ["ignore","pipe","pipe"]` was forced explicitly (`git-backend.ts`).
- `git commit-tree` doesn't inherit author identity and isn't idempotent by default — every call mints a fresh SHA with the current user as author unless `GIT_AUTHOR_*` env is passed through explicitly (`change-id.ts`).
- TypeScript 7.0.2's control-flow narrowing doesn't reliably track mutations of an outer `let` from inside a nested closure — a mutable object box sidesteps it (`planner.ts`, `findQualifiedSymbol`).
- A fresh `git clone` only checks out the default branch; other branches need an explicit `git checkout` before drip can diff them — not a drip bug, just how git works, documented in the README.
- Windows needs a junction, not a plain symlink, for the `node_modules` shortcut into each per-slice build-check worktree (`verify.ts`).

## Repos

- **https://github.com/fustilio/drip** — the tool
- **https://github.com/fustilio/drip-dummy** — fixture repo (`main`, `feature`, `feature2`)

## Immediate next action

Every milestone from the original plan is now either built or explicitly re-scoped by user decision: M0–M4 as planned, M5's deterministic half as planned, M5's AI half re-scoped from a bundled `--ai` provider to an external-tool interface (`plan --json` + an MCP server, `docs/adr/0009`), all verified live against `drip-dummy`. The one thing left: the M0 kill-gate, still explicitly deferred by the user in favor of continuing to build, not overlooked — it's the last ungated assumption everything else rests on.
