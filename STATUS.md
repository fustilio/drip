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
| M5 — DAG parallelism + AI | Not started | |

## What's verified, not just written

- Tree-hash invariant: passes on the dummy fixture, holds under branch regeneration (new commits added later), unaffected by `main` advancing independently, and survives a deliberately out-of-textual-order `git apply` (hoisted def-use, `feature2` branch).
- Per-slice build check: catches a real intentional type error, correctly propagates failure to downstream-dependent slices, passes clean otherwise.
- Change-Id assignment: idempotent (no-op on unchanged commits), preserves original author identity, only changes what actually needs a trailer.
- Overrides: `force_merge` combines independently-computed slices, `force_split` no-ops safely, unmatched selectors get reported not silently dropped.
- Push: real PRs opened and correctly stacked (verified via `gh pr view` on each), idempotent re-run (still 5 PRs, not 10), `--dry-run` has zero side effects (checked via `git ls-remote`).
- Cycle detection: a genuine mutually-recursive cross-file edit case (`planner.test.ts`) correctly returns `order: null` instead of silently mis-ordering — this had never been exercised before the test existed.
- M3 reconciliation: live-tested against `drip-dummy` by simulating a squash-merge (applying one slice's patch directly to `main`) and a content edit on another slice's already-pushed branch. Result: the squash-merged slice was dropped and its PR closed automatically, the edited slice got `[updated]` with a real interdiff comment, and the three untouched slices correctly reported `[unchanged]` with zero force-pushes.
- M4 comment anchoring: live-tested against `drip-dummy` by posting a real GitHub review comment on a slice's PR, then editing that exact hunk and re-pushing. The comment got a loud "couldn't be confidently relocated" reply threaded on the original thread. Re-running `push` again with no further changes did not double-reply — confirmed idempotent via `gh api` comment count staying at 2.

## Known limitations (accepted, not bugs)

- Slice correspondence (M2) is keyed by symbol composition, not diff content — see `docs/adr/0006`. A slice whose touched symbols change identity loses its PR link.
- Def-use edges are name-only regex matching, not scope-aware reference resolution (`planner.ts`, flagged inline).
- Override selectors break silently on symbol rename/move — no fuzzy relocation until M4's anchor system (`docs/adr/0004`).
- `git apply` per-slice ordering has only been tested against well-separated hunks with unique context; a pathological near-duplicate-context case could still trip fuzzy matching.
- Squash-merge detection is a reverse-apply-check against the base branch's current tip, not real content-addressing — it can false-negative (fail to detect) if surrounding context drifted, but won't false-positive silently drop a slice that wasn't actually merged (a failed reverse-apply just means "not detected," the slice still pushes normally).
- Comment anchoring only reconciles on pushes where the slice's content actually changed (piggybacks on the M3 content-hash check) — a comment posted on a slice that never gets touched again is never checked, which is fine (nothing to reconcile), but a comment posted then immediately squash-merged away is never reconciled either since squash-merged slices skip the push path entirely.
- Only top-level, right-side (`side: RIGHT`) review comments are considered; left-side (deleted-line) comments and thread replies are silently skipped rather than reconciled — see `docs/adr/0007`.

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

M3 and M4 are now built and verified live (M4 in its deliberately conservative, tier-1-only cut — see `docs/adr/0007`). The M0 kill-gate (blind boundary scoring — see `README.md`/`BUILD-PLAN.md` for the protocol) still hasn't been run — it remains explicitly deferred by the user in favor of continuing to build, not overlooked. Only M5 (DAG parallelism + AI conveniences) is left per the original plan.
