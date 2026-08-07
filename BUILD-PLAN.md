# drip — Build Plan

A tool for drip-feeding a mega branch back into main as thin, reviewable PRs.

**Status:** pre-M0. Nothing built. The immediate next action is the M0 spike and nothing else.

---

## 1. Problem

Thin PRs are good for reviewers and bad for authors. Splitting work up front loses the coherent view of how features interact and makes pattern consistency hard to enforce. Building it all in one branch gives you that view but produces an unreviewable diff.

Stacked PRs are the standard answer, and they mostly work. What they don't fix:

- **Review feedback forces restacks.** Every comment on a lower slice rewrites everything above it.
- **Force-push destroys review context.** Rewritten SHAs mark comment threads outdated; reviewers lose their place.
- **Squash-merge diverges local from remote.** After PR 1 lands squashed, the next restack produces phantom conflicts on already-merged code.
- **CI cost multiplies.** Every restack re-runs checks across the whole stack.
- **Restack cost is roughly quadratic in depth**, which is why the practical advice is to keep stacks to 3–5.

The underlying cause is not a tooling gap. Git's model is snapshots-of-a-branch; code review wants a **stable identity per logical change that survives revision**. Gerrit solved this with Change-Ids in 2008 and remains the main widely-used system that did. Graphite, ghstack, jj, and GitHub's native stacks are all reconstructing that identity on top of a system that lacks it.

`drip` takes the same approach, with one difference in emphasis: slices are treated as **derived projections**, not branches to be maintained.

---

## 2. Core inversion

The mega branch is the source of truth. Slices are regenerated, never rebased.

Because regeneration is idempotent and cheap, responding to review feedback stops being history surgery and becomes a re-render.

### Three layers

| Layer | Durability | Contents |
|---|---|---|
| **Intent** | Durable | Mega branch + change-id per logical unit |
| **Slice plan** | Derived, disposable | DAG of slices, content-addressed |
| **Correspondence** | Durable | slice ↔ PR ↔ review state ↔ comment anchors |

The durable/disposable split is the architecture. Rule of thumb: if it can be regenerated from the mega branch, it's a cache. Otherwise it goes in SQLite.

---

## 3. Four capabilities

### 3.1 Slicing is computed, not hand-drawn

Build a symbol-level dependency graph over the mega diff using tree-sitter, then topologically cluster hunks.

Shared types and helpers fall out as the bottom layer automatically — substrate-first slicing without requiring author discipline. It also serves the consistency goal directly: the tool *sees* when three features call the same new helper, because that's the edge it clustered on.

### 3.2 The stack is a DAG, not a line

Existing tools impose a total order on changes that are mostly independent. That's why restack cost goes quadratic.

If slice 4 touches nothing slice 1 touched, editing slice 1 doesn't rebuild it. Most restacks become no-ops and depth stops being the enemy.

### 3.3 Comments survive rewriting

Anchor each review comment to `(change_id, symbol_path, hunk_hash)` rather than `(sha, file, line)`.

On regeneration, relocate by matching the anchor:

1. Exact hunk hash
2. Symbol path
3. Fuzzy (optional, AI-assisted, always confirmed)

Comments that can't be relocated are surfaced as **orphaned — needs attention**, never silently dropped.

This is the capability no git-side tool currently provides, and the single largest source of the pain being solved.

### 3.4 Slices are content-addressed

A slice's identity is the hash of its normalised diff. Unchanged hash means: skip CI, skip force-push, don't touch the PR.

A five-slice stack with one edit re-runs CI once, not five times.

---

## 4. The invariant

```
apply(slices in topological order) == tree(mega branch)
```

Verified by tree hash. Plus: **every slice builds and passes tests standalone.**

If either check fails, `drip` refuses to push and names the slice that broke the chain.

Deterministic and checkable — you cannot be silently lied to about whether the projection is faithful. This is the tool's core promise, and it is why the verifier must never involve a language model.

---

## 5. Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | **Bun** | Fast CLI startup; `bun build --compile` gives a single binary later without a rewrite |
| Git access | **Shell out** | `diff-tree`, `cat-file`, `write-tree`, `commit-tree`. No git library needed; build slice trees in memory without touching the working directory |
| Parsing | **web-tree-sitter** | WASM grammars, no native build step, no install friction |
| Storage | **bun:sqlite** at `.git/drip.db` | Single file, no daemon |
| Tooling | Existing Biome + tsc setup | Already in place |

### Why TypeScript over Rust

Rust's advantages here are real but weaker than they first appear. `gix` is neutralised by shelling out to `git`. Distribution is handled by `bun build --compile`. Performance is not a concern at a few thousand files — this is not a hot path.

TypeScript wins on the thing that matters most: **M0 velocity**. The kill gate asks a question about output quality, not runtime, so the right language is whichever gets to the answer fastest. The existing toolchain also carries over, and agents write better TypeScript than Rust.

### Constraints (non-negotiable)

- Zero config to start
- One binary
- No daemon
- No network in the core path
- Deterministic output
- Meaningful exit codes for CI

---

## 6. Data model

```
change_id       stable, generated once, carried in a commit trailer
slice           content-hash of normalised diff + member change_ids
plan            DAG of slices — derived, disposable
correspondence  slice ↔ branch ↔ PR ↔ review state
anchor          comment ↔ (change_id, symbol_path, hunk_hash)
override        human boundary decisions; must survive replanning
```

---

## 7. Milestones

Total: roughly 10–11 weeks of evenings.

### M0 — Feasibility spike · 1–2 weekends

**The most important milestone.** Build nothing else until it passes.

A single TypeScript file. No CLI framework, no persistence, no tests, no types you don't need. Throwaway code — resist making it nice.

- **In:** a mega branch
- **Out:** printed slice DAG + pass/fail on the tree-hash invariant

**Kill gate:** run against three real mega branches. Are the proposed boundaries ones you'd have drawn by hand? **If under two-thirds are, stop.** Computed slicing doesn't work and the rest of the tool has no foundation.

This is the highest-information cheap experiment available. Everything downstream is contingent on it.

### M1 — Planner + verifier · 1.5–2 weeks

Rewrite M0 as real code. Commands: `drip plan`, `drip verify`.

- Per-slice standalone build check
- Boundary overrides
- SQLite persistence
- Change-id assignment via commit trailers
- `--timing` flag (collect performance data rather than worry about it)

**Gate:** is this useful with zero GitHub integration? If yes, ship it as-is.

### M2 — Projection and push · 1.5 weeks

`drip push` materialises slices as branches and opens PRs via the `gh` CLI.

- Read-only relationship to GitHub state
- Refuses to push if `verify` fails

Address distribution here (`bun build --compile`), not before.

### M3 — Regeneration and reconciliation · 3 weeks

**Most likely milestone to blow up. Timebox it.**

- Content-addressed skip (unchanged slice → no force-push, no CI)
- Squash-merge reconciliation: detect "this slice is now in main" by content, drop from plan
- Interdiff generation posted as a PR comment (GitHub won't render it natively)

Squash-merge divergence has a long tail of edge cases. Language choice changes nothing here — the difficulty is semantic.

### M4 — Comment anchoring · 3 weeks

The highest-value feature, and the reason the tool exists. Depends on everything above being solid.

Ship a deliberately conservative version: relocate only on high confidence, orphan the rest loudly.

### M5 — DAG parallelism and AI conveniences

- Independent slices no longer rebuild each other
- Then the three AI spots, all behind `--ai`, all optional

---

## 8. Hard problems

| Problem | Milestone | Fallback if it defeats you |
|---|---|---|
| Cross-cutting hunks | M1 | Manual override; ship without auto-resolution |
| Squash-merge divergence | M3 | Require merge-commit repos initially |
| Reviewer sees a moving target | M3 | Interdiff as bot comment |
| Merge queue + DAG | M5 | Linearise on submit |

---

## 9. AI policy

**~85% of the tool is deterministic, and that 85% is the part that has to be trustworthy.** The core value is a guarantee, and a guarantee produced by a model is not a guarantee.

### Deterministic, non-negotiably

- The faithfulness check (tree hash comparison)
- Content addressing, skip-CI decisions, DAG topology
- Comment re-anchoring by exact hash and symbol path
- Dependency extraction — symbol references are parseable, not inferable

### Three narrow places AI earns its place

1. **Slice naming and PR descriptions** — cosmetic; wrong output is annoying, never dangerous
2. **Fuzzy comment relocation, as the last tier only** — presented as a suggestion requiring a click, never applied silently
3. **Slice boundary suggestions where the graph is ambiguous** — AI proposes, human accepts, and the override is recorded deterministically so replanning honours it

### The pattern

**AI proposes, determinism disposes.** Every AI output is either cosmetic or gated behind a human confirmation that then becomes a durable deterministic fact. Nothing a model says is load-bearing on the next run.

### The design rule

**The tool must be fully usable with AI disabled.** If `--no-ai` produces a correct if duller result, this is a deterministic tool with AI conveniences. If it produces a *broken* result, it's an AI tool with deterministic decoration — and then it needs API keys, network access, and cost controls, and it stops being droppable into CI.

Worth noting: the AI in this workflow isn't in the tool. It's **upstream**, in the agents writing the mega branch. `drip`'s job is to be the deterministic, verifiable check on that output. Putting a model on both sides of that boundary defeats the point.

---

## 10. ADRs

Write these **after M0, not before.** Numbers 1 and 3 are the ones that will hurt to change later.

1. Slice identity — content hash vs. assigned ID
2. Change-id carriage — commit trailer vs. sidecar
3. Durable vs. derived boundary
4. Verification strictness — tree-equality only, or plus per-slice test pass
5. Override persistence semantics under replanning
6. AI as strictly optional; `--no-ai` correct by construction
7. Runtime boundary — which parts must stay portable to Rust, and what that forbids

On (7): no Bun-specific APIs in the planner core, and all git access behind a single `GitBackend` interface. Cheap insurance — it's the difference between a contained port and a rewrite.

---

## 11. Port trigger

Written down now so the decision is made on data rather than mood.

**Port the planner core to Rust if either holds:**

- `drip plan` exceeds ~10s on your largest real repo
- You want `drip` running as a required CI check

Everything else stays TypeScript. By that point you'll have a reference implementation and a test suite to port against, which is the easiest possible rewrite.

---

## 12. Next action

**M0 only.**

One file. One mega branch. One question answered: *are the computed slice boundaries ones I'd have drawn myself?*

That answer determines whether the remaining ten weeks are worth spending.
