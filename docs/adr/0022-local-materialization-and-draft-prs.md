# 0022 — Local materialization, and draft as a creation-only option

Status: accepted
Context: issue #13

## Problem

Every code path that produced a projection's actual commits lived inside
`push`: materialize, force-push the branch head, open or update the PR, comment
the interdiff. There was no way to *look at* a projection before all of that
happened.

That is the wrong order for the workflow the manifest exists to serve. A team
splitting an integration branch into a hand-reviewed PR set needs to compare an
intended projection against branches that already exist — often handwritten
ones with reviewers on them — and reconcile the scope disagreements before
anything is adopted or force-pushed. `validate-plan` says a projection applies
and reconstructs the tree; it does not hand you the tree.

The workaround was to read `plan`/`validate-plan` output and recreate the
commits by hand in a disposable clone. That throws away the validated
manifest-to-branch correspondence, which is the one thing drip is for, and it
is unreliable for hunk-level projections in the first place.

The second half of the issue is smaller and pulls the same direction: teams
that review this way want every new PR to start as a draft.

## Decision

### `drip materialize` — the same materialization, stopping at the repository

`drip materialize <branch> --manifest path [--projection flat-first|stacked]
[--only id[,id]] [--output dir] [--force]` validates the manifest exactly as
`validate-plan` does, then writes each projection's materialized commit to a
**local ref** — `drip/<branch>/<id>`, the same name `push` would use on the
remote — and, with `--output`, checks each one out into its own worktree.

It reuses `materializeFlatFirst` / `materializeSliceCommits` unchanged. This is
deliberately not a second materializer: a preview that could disagree with what
`push` sends would be worse than no preview.

Nothing else happens. No remote ref is written, no `gh` is invoked, no
correspondence row is recorded — a projection materialized here is not a
projection drip believes it owns. The report says so on every run, because
"did that touch GitHub?" is the question the command exists to answer.

**Flat-first is the default here, unlike `push`.** A manifest's `dependsOn`
graph *is* the flat-first base selection; it is what `validate-plan` and
`manifest adopt` already materialize, so materializing anything else by default
would preview something the manifest was never validated as. `--projection
stacked` stays available for previewing what `push`'s own default would send.

### Sameness is judged by tree, and only trees can be clobbered

`git commit-tree` mints a fresh sha on every invocation, so comparing shas
would make every re-run look like a rewrite. A ref that already exists at the
same **tree** is left exactly where it is and reported `unchanged`; one that
exists at a different tree is reported `blocked` and *not moved* until
`--force`. That ref may be something the operator is mid-way through comparing
against a colleague's branch — the one destructive act in an otherwise
read-only command is worth a flag. The same rule covers an existing worktree
path.

### Selection materializes the closure, never a narrowed base

`--only` picks which projections get refs and worktrees. It does not change
what they are built on: everything is materialized internally, and a selected
projection's prerequisite closure is written alongside it, marked
`(prerequisite)` rather than presented as a chosen projection. A subset that
quietly rebased itself onto the base branch would be materializing something
other than what `push` would send, which defeats the point. In stacked mode the
"closure" is the whole prefix, because that is what a stacked chain means.

### An adopted projection still materializes to drip's own ref

Where `push` writes to the adopted branch, `materialize` writes to
`drip/<branch>/<id>` and reports the binding, with the `git diff` between the
two. Overwriting a local copy of somebody else's branch to preview a projection
would be exactly the accident this command exists to help avoid — and the
comparison is the deliverable, so the two refs need to both exist.

### `--draft` is a creation-only option

`push --draft` passes `--draft` to `gh pr create` and nowhere else.

There is no `gh pr edit --draft`, and more to the point an existing PR's
draft/ready state is a review decision someone made: a re-run that flipped a
PR marked ready back to draft would be drip undoing a human. So an existing
PR — drip's own or an adopted one — keeps its state, and if `--draft` was
passed anyway the result says why rather than letting the flag look like it
did something.

`PushResult.draft` is three-valued for the same reason: `true`/`false` is the
state this run *sets* while opening a PR, and `null` means no PR is being
opened. Dry-run carries it, since "would open five drafts" is precisely what a
preview has to say before `--yes`.

## Consequences

- `materialize` accepts `--worktree` like `plan` and `verify` do, and unlike
  `push`, which refuses it. Local refs built from working-tree content are real
  objects in the operator's own repository; the refusal on `push` is about
  opening PRs from content that exists nowhere else, which does not apply here.
- `cli.ts` grew a shared `checkManifest` step, now used by `validate-plan`,
  `materialize` and `push --manifest` — the third copy of resolve-then-validate
  was one too many.
- `materialize` auto-discovers the conventional manifest location, on the same
  rule as `validate-plan`: discovery is fine for reading, and forbidden for
  deciding what `push --yes` sends to GitHub.
- `validateManifestAgainstGit` now takes `sourceRef` and passes `plan.excluded`
  to the tree-hash check. Trying `materialize --worktree` is what found this:
  the check compared the projections against the *branch tip* regardless of the
  plan's diff source, so `validate-plan --worktree` reported a tree-hash
  mismatch on any dirty tree — a latent bug from issue #12, since worktree mode
  is supposed to substitute the source and nothing else (docs/adr/0021).
- No `drip_materialize` MCP tool. Writing refs and worktrees into someone's
  repository is a local side effect, and the MCP surface is deliberately the
  read-and-record-a-decision half of drip (docs/adr/0009).
- Worktrees created by `--output` persist — they are the deliverable. They get
  no `node_modules` symlink (unlike the throwaway ones in `verify.ts` and
  `verification.ts`), since these outlive the command and a symlink into the
  main checkout would be a surprising thing to leave behind. `git worktree
  remove` cleans them up.
