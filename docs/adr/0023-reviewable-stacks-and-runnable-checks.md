# 0023 — Reviewable stacks, and checks that actually ran

Status: accepted
Context: issue #14

## Problem

Run against a real TypeScript monorepo, drip found a valid atomic DAG and
materialized a manifest correctly — and the PR graph it produced still wasn't
something a team could review or merge. Two separate gaps, both of them in the
space between "a valid patch DAG" and "a reviewable, CI-verifiable GitHub
stack".

**A generated integration base has no PR.** Under `--projection flat-first`, a
projection with two prerequisites gets a minted `drip/<branch>/<id>-base`
branch whose tree is the prerequisite closure (docs/adr/0016). GitHub will
merge the child PR against it quite happily, and:

- reviewers cannot walk the prerequisites as a stack, because two of the three
  nodes in that subgraph have no PR to open;
- a workflow declared as `pull_request.branches: [main]` never fires on the
  child, because its base isn't `main`. The PR looks green because nothing ran.

**A safety gate that skips is not a safety gate.** The per-slice build check
defaulted to `tsc --noEmit` when a *root* `tsconfig.json` existed and skipped
otherwise. npm/pnpm/bun workspaces usually have no root tsconfig — the
tsconfigs are one directory down — so on exactly the repositories where a
mechanically split projection is most likely to be missing a symbol, the check
silently evaporated. `manifest.verification` catches this, but only once
commands are written, and `verificationReason` let a projection opt out of
having any. The result was draft PRs that reconstructed the mega branch's tree
perfectly and did not compile.

## Decision

### Hidden integration bases are named, and refusable

Every run that leaves a PR pointing at a generated integration base now says
so, in the result line (`base: drip/x/y-base (generated, not reviewable on
GitHub)`), in the per-slice note (which names the CI consequence), and in a
summary block after the results. `PushResult.hiddenBase` carries it
structurally so this isn't string-matching.

`push --reviewable-stack` refuses instead: a projection that would need a
generated base is reported `blocked`, nothing is pushed for it, and the exit
code is 1. The error names the two ways out — merge those prerequisites into
one projection, or declare a projection that depends on them and depend on
*that*. Both produce a stack where every base is a branch with a PR on it.

**Refusal propagates.** A dependent of a refused projection would open a PR
against a branch that was never pushed, so it is refused too, with a note
saying which prerequisite it was waiting on. `push` already had this hole for
the apply-failure case and got away with it only because
`materializeFlatFirst` happened to fail the dependents as well; it is now
explicit in `push()` via a `blockedIds` set.

The flag is opt-in and the default is unchanged. Flipping it would break the
flat-first workflow that issue #6 exists to provide, for repositories whose
review process is fine with a merge-only base. Making the situation impossible
to *miss* is the part that shouldn't be optional, and that is now unconditional.

The alternative the issue offers — open a visible draft PR for the generated
base and target the child at it — is deliberately not taken. drip would be
inventing a review unit nobody declared, with no title, no intent and no
verification commands, in a manifest whose entire premise is that those come
from outside drip (docs/adr/0018). A team that wants that PR can declare it as
a projection, which is the same thing with an author.

### drip runs what the repository declares, and offers the rest

`src/workspace.ts` discovers what a JS/TS repo says about checking itself:
package manager (from the lockfile), workspace packages (by walking for
`package.json`, not by expanding per-manager workspace globs), and each
package's check-shaped scripts.

Two uses, deliberately different:

- **A root command drip will run unprompted** — a root `tsconfig.json`
  (unchanged: `bunx tsc --noEmit`) or a root `typecheck`/`type-check` script.
  Both are things the repository named for itself. drip does not compose a
  whole-repo command out of package-level pieces: guessing someone's workspace
  invocation and then failing their push on the result is worse than saying it
  can't. A root `test` script is not promoted either — running an unasked-for
  suite once per slice is not a default drip gets to pick.
- **Per-package commands it only offers**, printed ready to paste into a
  projection's `verification`. Discovery never executes anything; a manifest
  command runs because someone declared it (docs/adr/0019).

And the skip message stops being a shrug: it says what's missing, what this
repo offers instead, and that a projection can reconstruct the tree and still
not compile.

### `--require-verification`: a reason is not a check

Under `--require-verification`, a projection whose files include code
(`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) must declare at least one
`verification` command. `verificationReason` no longer exempts it — that field
records a *decision*, and this flag is for the caller who has decided such
decisions aren't allowed to cover code. New finding `verification-waived`,
error severity, so it gates `validate-plan`, `materialize` and
`push --manifest` alike, and is exposed on `drip_validate_plan` over MCP.

Docs-, config- and lockfile-only projections keep the existing rule: a README
has nothing for a typecheck to have an opinion about, and demanding a command
there would train people to write a fake one.

It is a separate flag from `--strict` rather than folded into it. `--strict`
has one precise meaning — every warning becomes an error — and this is a rule,
not a severity change. They compose.

## Consequences

- `BuildOutcome`'s `no-command` case carries the discovered `WorkspaceChecks`,
  and `ran` carries where the command came from, so `BUILD CHECK: PASS` can say
  when it used the repo's own script rather than a tsconfig.
- `DEFAULT_BUILD_CMD` moved from `verify.ts` to `workspace.ts` as
  `DEFAULT_TSC_CMD`; the "what should we run" decision now lives in one module.
- A repository that has a root `typecheck` script and no root tsconfig will
  start running a per-slice build check where it previously ran none. That is
  the fix, not a side effect; `--no-build-check` still turns it off.
- `isCodeFile` intentionally covers more than the planner can parse: `.mts` and
  `.cts` have no grammar loaded, so they fall into fallback groups, but a
  typecheck still has plenty to say about them.
- `materialize` reports a projection's integration base as generated and
  unreviewable too. It doesn't refuse — refusing to produce a *local* ref
  because the corresponding PR would be awkward defeats the point of a preview.
