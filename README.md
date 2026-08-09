# drip

A tool for drip-feeding a mega branch back into main as thin, reviewable PRs. Slices are derived projections of the mega branch, not maintained branches — regenerated, never rebased.

**Status:** M0 (feasibility spike) built. M1 (real CLI, `drip plan`/`drip verify`) built. M2 (`drip push`, real PRs via `gh`) built. M3 (content-addressed skip, squash-merge reconciliation, interdiff comments) built. M4 (comment anchoring, conservative exact-hash-only cut) built. M5's deterministic half (build-check caching, parallel per-slice builds) built. M5's AI half re-scoped away from a bundled provider to `plan --json` and an MCP server (`drip mcp`) for external tools (`docs/adr/0009`). **The M0 kill-gate blind-boundary scoring against real branches has not been run yet** — see `BUILD-PLAN.md` for what that means and why everything downstream is contingent on it. See `CONTEXT.md` for the domain model, and `docs/adr/` for the architecture decisions.

## CLI

```bash
bun install
bun src/cli.ts plan <branch> [--repo path] [--base branch] [--timing] [--assign-ids] [--json] [--coarsen] [--target-slices n] [--emit-manifest [--manifest path] [--force]]
bun src/cli.ts verify <branch> [--repo path] [--base branch] [--timing] [--coarsen] [--target-slices n] [--build-cmd cmd] [--no-build-check]
bun src/cli.ts push <branch> [--repo path] [--base branch] [--projection stacked|flat-first] [--manifest path] [--no-manifest-check] [--strict] [--build-cmd cmd] [--no-build-check] --yes | --dry-run
bun src/cli.ts validate-plan <branch> [--manifest path] [--repo path] [--base branch] [--json] [--no-manifest-check] [--strict]
bun src/cli.ts manifest adopt <branch> --projection id --pr n --head branch [--manifest path] [--repo path] [--base branch] [--remote name] [--json] [--yes]
bun src/cli.ts manifest list <branch> [--repo path]
bun src/cli.ts manifest forget <branch> --projection id [--repo path]
bun src/cli.ts mcp
```

- **`plan`** — diffs `<branch>` against its merge-base with `--base` (default `main`), clusters hunks into slices via a tree-sitter symbol-edge graph (TypeScript/JavaScript only), prints the slice DAG. `--assign-ids` injects Gerrit-format `Change-Id` trailers into any commit missing one (opt-in, rewrites the branch in place, prints the old→new SHA mapping — never automatic). `--json` prints only a machine-readable plan (slices, files, symbols, edges, unmatched override selectors) — no other output — for an external tool to read ambiguous-boundary/naming context and write decisions back through `drip override add`. See BUILD-PLAN.md §9: the AI belongs upstream of the tool, not inside it — there's no `--ai` flag or bundled provider integration here on purpose.
  Hunks tree-sitter can't map to an enclosing symbol don't go into one catch-all bucket: each gets a deterministic per-file **fallback group** (`<path>::(file)`, or `<dir>/package.json::(deps)` for a manifest and its lockfile) with the reason it's unassigned, and those selectors work with `override add` like any symbol — see `docs/adr/0015-fallback-grouping.md`.
- **`--coarsen`** — an optional planning mode above the atomic slice DAG: groups slices into review-sized **candidate projections** using four deterministic rules (a file's top-level hunks join that file's symbol slice; a test joins the production file it exercises; a helper with one consumer is absorbed into it; and, only under `--target-slices n`, same-feature-directory merging until the budget is met). Each projection lists its constituent slices, its external prerequisites, and why each merge happened. `force_split` is never coarsened away — a budget that would need it is reported unmet. See `docs/adr/0017-review-sized-coarsening.md`.
- **`verify`** — runs `plan`, then checks the tree-hash invariant (`apply(slices in topological order) == tree(branch)`) and a per-slice standalone build check (`bunx tsc --noEmit` by default if `tsconfig.json` exists, or `--build-cmd`). With `--coarsen`, both checks run against the coarsened projections instead, proving the coarsening still reconstructs the mega-branch tree.
- **`override add|list|remove`** — boundary overrides (`force_merge` / `force_split`, keyed by `file::QualifiedSymbolPath`) persist in `.git/drip.db` and survive replanning:
  ```bash
  bun src/cli.ts override add <branch> --kind force_merge --selector-a file::Symbol --selector-b file::Symbol [--note text] [--repo path]
  bun src/cli.ts override add <branch> --kind force_split --selector-a file::Symbol [--note text] [--repo path]
  bun src/cli.ts override list <branch> [--repo path]
  bun src/cli.ts override remove <id> [--repo path]
  ```
- **`push`** — refuses if `verify` fails. Materializes each slice as a `drip/<branch>/sliceN` branch and opens a PR via `gh` for each one that doesn't already have a correspondence entry (re-running updates the existing branch/PR instead of duplicating it — see `docs/adr/0006-slice-correspondence-key.md`). `--dry-run` previews without touching GitHub; otherwise `--yes` is required, since this is the one command with real external side effects.
  - `--projection stacked` (default) chains every PR onto the previous slice's branch.
  - `--projection flat-first` picks each base from the DAG instead: independent roots target the base branch, a slice with one prerequisite targets that prerequisite's branch, and a slice with several gets a generated `drip/<branch>/sliceN-base` integration branch. Nothing is made a review dependency purely by topological ordering — see `docs/adr/0016-flat-first-projection.md`. A slice whose hunks won't apply on its prerequisites alone is reported `blocked` and not pushed (exit 1), never silently dropped.
- **`validate-plan`** — checks a **semantic projection manifest** against the current plan. Coarsening can balance slices; it cannot know that six of them are "the report-tab detail experience". So that boundary is stated explicitly in a JSON manifest, proposed by whatever is upstream (an agent reading `plan --json`, a human, both), and validated deterministically here — never derived, never auto-discovered, never written by drip. See `docs/adr/0018-semantic-projection-manifest.md`.

  ```jsonc
  {
    "version": 1,
    "sourceBranch": "mega-appeals",
    "budgets": { "files": 20, "hunks": 60, "changedLines": 800 },
    "projections": [
      {
        "id": "report-tab-details",
        "title": "feat(appeals): show Report-tab details",
        "intent": "Expose and render report, offence, offender and vehicle detail.",
        // durable group-key selectors, not `slice17` ordinals — those renumber on replan
        "atomicSlices": ["src/appeals/report.ts::renderReport"],
        "glue": ["src/appeals/report.ts::(file)"],
        "dependsOn": ["appeals-dto"],
        "verification": ["bun run typecheck", "bun test src/appeals"]
      }
    ],
    "defer": [{ "slice": "README.md::(file)", "reason": "ships with the release notes" }]
  }
  ```

  **`verification` is executed, not documented.** Each projection's commands run against *its own materialized tree* — the prerequisite closure its PR would show — so a projection that applies cleanly and reconstructs the final tree, but isn't actually runnable because it's missing a fixture, an export or a route registration, fails here rather than in review. A failure blocks `validate-plan` and refuses `push`. Results are cached by the tree they ran against, so independent projections aren't re-checked when something unrelated moves, and captured output is written to `<gitdir>/drip/verification/<branch>/` and reported by path. A projection with no commands warns unless it sets `verificationReason`; `--strict` turns every warning into a failure (useful in CI), and `--no-manifest-check` skips execution entirely for local experimentation. See `docs/adr/0019-executable-verification.md`.

  **Where it lives.** With no `--manifest`, `validate-plan` looks in `.drip/projections/<branch>.json` (in the working tree, committable — an approved review plan is a document a team argues about and keeps) and then `<gitdir>/drip/projections/<branch>.json` (private to the clone). `drip plan <branch> --coarsen --emit-manifest` writes a valid starting skeleton there — every slice assigned, real selectors filled in — for you or an agent to give real ids, titles and intents; it refuses to overwrite without `--force`. `push` deliberately does **not** auto-discover: a manifest left lying around must never silently change what `push --yes` sends to GitHub, so it says one exists and pushes atomic slices unless you pass `--manifest`.

  Validated: every slice assigned exactly once or explicitly deferred with a reason; nothing deferred that another projection needs; the `dependsOn` graph acyclic; every atomic dependency crossing a boundary declared (widening is fine, dropping is not); each projection actually applies on its declared prerequisites; shared glue reachable from everyone who needs it; budgets respected unless `oversizeReason` says otherwise; and the whole graph still reconstructs the mega-branch tree — deferred slices included, so deferral can't silently lose work. `push --manifest` runs the same validation and refuses on any error; a projection's PR is keyed on its manifest `id`, so replanning underneath it doesn't cost the PR its identity or its review comments.
- **`manifest adopt|list|forget`** — binds a semantic projection to a PR that **already exists**, instead of opening a drip-owned one. Teams usually don't start from a mega branch: a few good, small, handwritten PRs exist first — with reviewers, comments and branch names people link to — and only later does an integration branch expose their combined dependency graph. Without adoption, `push --manifest` sees no correspondence for them and opens a parallel `drip/<branch>/<id>` set beside them.

  ```bash
  bun src/cli.ts manifest adopt appeals --projection report-tab-details --pr 373 --head tims-630-port-report-tab-sections --yes
  ```

  Projection id, PR number and head branch are all required and cross-checked — adoption on two out of three would be a heuristic, and a wrong guess here becomes a future force-push over someone else's branch. The binding is recorded only if the branch's **effective diff**, replayed onto the mega branch's merge base, produces exactly the tree the projection materializes (itself plus its declared prerequisite closure). Anything else is refused with an interdiff; a branch carrying its own change but cut from the base branch rather than from its prerequisites is called out by name, since that reads identically to "wrong PR" in a raw diff and means something quite different.

  Adoption never touches the remote — no push, no retarget, no comment. Afterwards, `push --manifest --projection flat-first` updates that PR through the normal correspondence path (interdiff comment, comment anchoring, squash-merge detection), and a *dependent's* base names the adopted branch rather than a drip-owned one. Three things change because drip doesn't own an adopted branch: it force-pushes **with a lease** (a reviewer's commit pushed in between blocks the push instead of vanishing), it skips whenever the branch already shows the projection's tree rather than on a content-hash match, and it **never retargets** the PR — a base that disagrees with the manifest graph is reported on every push, and changing it means changing it on the PR and re-running `manifest adopt`. `manifest list` shows every projection PR and whether drip opened it or adopted it; `manifest forget` drops a mis-binding without touching the PR. See `docs/adr/0020-adopting-existing-prs.md`.
- **`mcp`** — starts an MCP stdio server exposing `drip_plan`, `drip_verify`, `drip_validate_plan`, `drip_override_list`, `drip_override_add`, `drip_override_remove` as tools, so an MCP client (an agent, an editor integration) can read plan/verify data and write override decisions without shelling out to the CLI. No `push` or `manifest adopt` tool — one has real side effects and the other decides that drip may later force-push over a branch it doesn't own; both need `--yes` from a human. No AI provider inside drip anywhere — see `docs/adr/0009-ai-integration-external-not-bundled.md`.

## M0 spike

`m0.ts` is the original throwaway single-file spike this was built from — kept as-is, superseded by `src/`.

### Try it

[drip-dummy](https://github.com/fustilio/drip-dummy) is a fixture repo for exercising the tool: `main` is the base, `feature` is a mega branch with a shared helper called from two routes plus unrelated noise, `feature2` stress-tests hoisted def-use ordering.

```bash
git clone https://github.com/fustilio/drip-dummy dummy-repo
cd dummy-repo && git checkout feature && cd ..  # branches other than the clone's default aren't checked out locally yet
bun src/cli.ts verify feature --repo dummy-repo
```

## Tests

```bash
bun test
```

Runs against real git in disposable temp repos (`src/test-helpers.ts`), not a fake `GitBackend` — see `docs/adr/0010-test-against-real-git.md` for why. The one real external boundary, GitHub's API (`src/github.ts`), is mocked via `bun:test`'s `mock.module` in `push.test.ts` and `adopt.test.ts`; everything else runs real git plumbing, including a real `git push` to a local bare repo standing in for a remote, and — in the adoption suite — real handcrafted branches on that remote for drip to compare against.
