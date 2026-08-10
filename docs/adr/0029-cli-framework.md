# 0029 — Per-command flags, from a CLI framework

Status: accepted
Context: the dispatcher had grown past what one shared flag table can express

## Problem

`cli.ts` parsed every command with a single `parseArgs` call over one flat table
of ~35 options, then dispatched on a chain of `if (command === ...)`. The chain
was never the cost — it was about twelve lines. The table was.

Because every command shared one table, per-command flag ownership existed only
in comments (`// score only:`, `// materialize only:`), and nothing enforced it:

```
$ drip plan main --base main --reclaim --threshold 99 --layer nonsense
source: branch main
No changes between main and main — nothing to slice.
exit=0
```

Three flags that mean nothing to `plan` — one of which `score` would reject
outright — parsed clean and exited 0.

Three more consequences followed from the same root:

- **Every value arrived as a string** and was coerced and validated by hand
  afterwards, 22 lines of it: `Number(values.limit)` plus an integer check,
  `Number(values.threshold)` plus a range check, `values.layer as ScoreLayer`
  plus a three-way comparison, `--projection` compared against two literals in
  two different places.
- **`--projection` meant two different things.** The base-selection mode on
  `push` and `materialize`, a projection *id* on `manifest adopt`,
  `manifest forget` and `review-context`. One table has room for one entry, so
  the overload was unavoidable and the comment on it said as much.
- **Help was a hand-maintained string.** A ~30-line `usage()` block listing
  every flag of every command, kept in sync by remembering to. Adding
  `--reclaim` in ADR 0028 meant editing it by hand.

## Decision

`@stricli/core` (Bloomberg, zero runtime dependencies), with each command
declaring its own flags, parsers and docs in `src/commands/`.

`src/cli.ts` is now only the shape of the interface — a route map — and each
command module owns its parameters and calls the same modules the MCP server
does. The four alternatives that got as far as being compared:

| | Verdict |
|---|---|
| **@stricli/core** 1.3.0 | Chosen: zero deps, per-command scoping, generated help, built for bundling |
| commander 15 | Viable fallback: zero deps, universal, weaker type inference |
| citty | Still 0.x after years |
| clipanion | 4.0.0-rc.4 since September 2024 |
| yargs | Six transitive dependencies |
| oclif | Plugin/hook/generator architecture, for a single-binary tool |
| the zod-CLI packages | Tempting since zod is already a dependency, but small single-maintainer projects, several still on zod 3 — the wrong risk in the boot path of a tool that force-pushes |

**The CLI surface does not change.** stricli's own convention is camelCase
flags, which would have turned `--target-slices` into `--targetSlices` and
broken every documented invocation. `scanner: { caseStyle: "allow-kebab-for-camel" }`
accepts both, so the kebab-case surface the README documents keeps working
exactly as before. This was found by spiking, not by reading.

**Errors stay drip's.** A `DripError` thrown from a command body would otherwise
be caught by stricli and printed as `Command failed, Error: ...` plus a stack
trace. Each command body is wrapped by `command()` in `src/commands/shared.ts`,
which prints the same single `error: ...` line and exits 1 that the CLI has
produced since M1.

**`--projection` stops being overloaded** without being renamed. It is now
declared separately on the commands that take a mode and the commands that take
an id, each with its own parser and help text. The ambiguity was a property of
the shared table, not of the name.

## Consequences

- **A flag that doesn't belong to a command is now an error**, which is a
  behaviour change for anyone who was passing one. It was never doing anything.
- **`push --worktree` and the `--assign-ids` refusals moved.** `push` simply
  doesn't declare `--worktree` any more, so the parser rejects it and `--help`
  shows it was never on offer. The `--assign-ids` refusal stays a runtime check,
  since both flags are legitimately on `plan`.
- **Coercion happens before the command body runs**, so `--limit zero` fails at
  the parser naming the flag, rather than several steps into a git operation.
- **Help is generated** from the same declarations that do the parsing, and the
  generated top-level output reproduces the old hand-written block.
- **`src/cli.ts` went from 833 lines to about 50**, with the bodies in nine
  command modules. That was a consequence of the migration rather than its
  motivation.
- **One runtime dependency added.** Zero-dependency itself, so the tree grows by
  exactly one.
- **`src/cli.test.ts` exists.** The CLI had no direct tests, which is precisely
  why a shared table could accept `--reclaim` on `plan` for as long as it did.
  21 tests over the real binary as a subprocess, covering flag scoping, the
  kebab-case surface, every parser, the required-input refusals and the error
  format.

## What this does not address

`mcp.ts` exposes an overlapping command surface, and a CLI framework does
nothing for it. The thing that de-duplicates the two is `workflow.ts`
(docs/adr's first architecture pass), and it stays the seam. Making the CLI
framework serve both would put an interface concern underneath the MCP server
for no benefit.
