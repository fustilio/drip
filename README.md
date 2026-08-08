# drip

A tool for drip-feeding a mega branch back into main as thin, reviewable PRs. Slices are derived projections of the mega branch, not maintained branches — regenerated, never rebased.

**Status:** M0 (feasibility spike) built. M1 (real CLI, `drip plan`/`drip verify`) built. M2 (`drip push`, real PRs via `gh`) built. M3 (content-addressed skip, squash-merge reconciliation, interdiff comments) built. M4 (comment anchoring, conservative exact-hash-only cut) built. M5's deterministic half (build-check caching, parallel per-slice builds) built. M5's AI half re-scoped away from a bundled provider to `plan --json` and an MCP server (`drip mcp`) for external tools (`docs/adr/0009`). **The M0 kill-gate blind-boundary scoring against real branches has not been run yet** — see `BUILD-PLAN.md` for what that means and why everything downstream is contingent on it. See `CONTEXT.md` for the domain model, and `docs/adr/` for the architecture decisions.

## CLI

```bash
bun install
bun src/cli.ts plan <branch> [--repo path] [--base branch] [--timing] [--assign-ids] [--json]
bun src/cli.ts verify <branch> [--repo path] [--base branch] [--timing] [--build-cmd cmd] [--no-build-check]
bun src/cli.ts push <branch> [--repo path] [--base branch] [--build-cmd cmd] [--no-build-check] --yes | --dry-run
bun src/cli.ts mcp
```

- **`plan`** — diffs `<branch>` against its merge-base with `--base` (default `main`), clusters hunks into slices via a tree-sitter symbol-edge graph (TypeScript/JavaScript only), prints the slice DAG. `--assign-ids` injects Gerrit-format `Change-Id` trailers into any commit missing one (opt-in, rewrites the branch in place, prints the old→new SHA mapping — never automatic). `--json` prints only a machine-readable plan (slices, files, symbols, edges, unmatched override selectors) — no other output — for an external tool to read ambiguous-boundary/naming context and write decisions back through `drip override add`. See BUILD-PLAN.md §9: the AI belongs upstream of the tool, not inside it — there's no `--ai` flag or bundled provider integration here on purpose.
- **`verify`** — runs `plan`, then checks the tree-hash invariant (`apply(slices in topological order) == tree(branch)`) and a per-slice standalone build check (`bunx tsc --noEmit` by default if `tsconfig.json` exists, or `--build-cmd`).
- **`override add|list|remove`** — boundary overrides (`force_merge` / `force_split`, keyed by `file::QualifiedSymbolPath`) persist in `.git/drip.db` and survive replanning:
  ```bash
  bun src/cli.ts override add <branch> --kind force_merge --selector-a file::Symbol --selector-b file::Symbol [--note text] [--repo path]
  bun src/cli.ts override add <branch> --kind force_split --selector-a file::Symbol [--note text] [--repo path]
  bun src/cli.ts override list <branch> [--repo path]
  bun src/cli.ts override remove <id> [--repo path]
  ```
- **`push`** — refuses if `verify` fails. Materializes each slice as a `drip/<branch>/sliceN` branch, stacked (each PR's base is the previous slice's branch, per-slice content chained as real commits), and opens a PR via `gh` for each one that doesn't already have a correspondence entry (re-running updates the existing branch/PR instead of duplicating it — see `docs/adr/0006-slice-correspondence-key.md`). `--dry-run` previews without touching GitHub; otherwise `--yes` is required, since this is the one command with real external side effects.
- **`mcp`** — starts an MCP stdio server exposing `drip_plan`, `drip_verify`, `drip_override_list`, `drip_override_add`, `drip_override_remove` as tools, so an MCP client (an agent, an editor integration) can read plan/verify data and write override decisions without shelling out to the CLI. No `push` tool — that command has real side effects and needs `--yes` from a human. No AI provider inside drip anywhere — see `docs/adr/0009-ai-integration-external-not-bundled.md`.

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

Runs against real git in disposable temp repos (`src/test-helpers.ts`), not a fake `GitBackend` — see `docs/adr/0010-test-against-real-git.md` for why. The one real external boundary, GitHub's API (`src/github.ts`), is mocked via `bun:test`'s `mock.module` in `push.test.ts`; everything else runs real git plumbing, including a real `git push` to a local bare repo standing in for a remote.
