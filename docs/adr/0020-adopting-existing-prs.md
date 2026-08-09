# 0020 — Adopting pre-existing PRs into a manifest

Status: accepted
Context: issue #11

## Problem

`push --manifest` maintains correspondence for PRs drip opened. Real teams
usually arrive the other way round.

Several good, small PRs already exist, handwritten, with reviewers, comments,
approvals and branch names other people link to. Later an integration branch
exposes their combined dependency graph and motivates a semantic manifest
(docs/adr/0018). At that point `drip push --manifest` has no way to see those
PRs: it finds no correspondence, so it opens a parallel `drip/<branch>/<id>`
set beside them.

That forces a choice between abandoning the review context that already exists
and not using drip for the integration workflow at all. Neither is acceptable,
and the missing piece is small: a durable link between a semantic projection id
and a PR drip did not create.

## Decision

An explicit, non-automatic `drip manifest adopt`, which binds one projection to
one existing PR after proving the branch's content is exactly what that
projection materializes.

```bash
drip manifest adopt appeals --projection report-tab-details \
  --pr 373 --head tims-630-port-report-tab-sections
```

All three of projection id, PR number and head branch are required, and they
are cross-checked against each other (`gh pr view`'s `headRefName` must be the
branch the caller named). Adoption on two out of three would be a heuristic,
and a wrong guess here is not a bad report — it is a future force-push over an
unrelated team's branch.

### The check is a tree comparison, not a similarity score

Trees can't be compared directly: a handcrafted branch was cut from whatever
`main` was that day, not from the mega branch's merge base. Its *effective
diff* can be. So drip replays what the branch adds over the base branch
(`merge-base(base, head)..head`) onto the mega branch's merge base, and
compares the resulting tree with the tree the projection materializes under
flat-first (docs/adr/0016) — the projection plus its declared prerequisite
closure, which is exactly what its PR would show.

Equal trees is the only pass. Anything else is refused with an interdiff
(projection → branch), and one shape is named outright rather than left to be
read out of a diff: a branch that carries the projection's own change but is
cut from the base branch instead of from the prerequisites the manifest
declares. That looks identical to "wrong PR" in a raw interdiff and isn't — it
means the PR is not independently reviewable as it stands, and the fix is a
rebase or a correction to `dependsOn`.

### Adoption never touches the remote

The command fetches, compares, and writes one correspondence row. It does not
push, retarget, comment, or rewrite anything, and it prints the full report
before `--yes` records anything. What it changes is what a *later*
`push --manifest` will do — which is why it wants an explicit confirmation of
its own rather than riding on push's.

The recorded commit sha is the human's head, not a drip-materialized one, so
the first drip update posts its interdiff against the branch reviewers actually
saw.

### An adopted branch is someone else's property

Three behaviours follow from that, all in `push`:

- **Leased force-push.** drip owns `drip/<branch>/*` exclusively, so plain
  `--force` is right there. An adopted branch is shared, so the push uses
  `--force-with-lease` against the sha drip recorded. If a reviewer pushed a
  fix in between, the push fails and the unit is reported `blocked` with what
  to do about it, instead of silently discarding a commit drip never saw.
- **Content, not hash, decides "unchanged".** A drip-owned branch is skipped
  when its content hash matches. An adopted one is skipped whenever the branch
  already shows the projection's tree — the hash also moves when the chosen
  *base string* does, and rewriting a reviewer-visible branch to change nothing
  but its commit graph is pure loss.
- **No silent retargeting.** drip re-bases a PR it opened when the graph says
  so. On an adopted PR the base is a review decision someone else made, so a
  disagreement with the manifest graph is reported on every push and left
  alone. Changing it is an explicit act: change the base on the PR, then re-run
  `manifest adopt` to re-bind.

### Ids, not branches, are what's bound

Correspondence identity is still `manifest:<id>` (docs/adr/0018) — adoption
only supplies a different branch and PR for that identity. So a projection can
be resliced underneath without losing the adopted PR, several independent
handcrafted PRs adopt into one manifest, and the same `manifest forget`
undoes a mis-binding without touching the PR.

A branch or PR already bound to another projection is refused: two projections
force-pushing one branch would each undo the other.

## Consequences

- `push` resolves every unit's branch name through correspondence rather than
  recomputing `drip/<branch>/<label>`. A *dependent's* base therefore names the
  adopted branch of its prerequisite, which is what makes a partly-adopted
  manifest coherent rather than half-parallel. This applies to drip-owned
  branches too, and closes a latent bug there: a PR's head branch is fixed when
  it's opened, so a unit whose label changed under a stable signature used to
  get its content pushed to a *new* branch the existing PR wasn't looking at.
- `correspondence` gains an `adopted` column. It can't be re-derived from the
  branch name — a team branch that happens to look drip-owned would get plain
  force-pushes — so it lives in the durable record.
- Adoption is CLI-only, deliberately not an MCP tool, for the same reason
  `push` isn't (docs/adr/0009): it is the decision that lets drip later
  force-push over a branch it doesn't own, and that wants a human's `--yes`.
- `--projection` now names the projection id on `manifest adopt` and the
  base-selection mode on `push`. It has no default any more, so adopt can tell
  "not given" from "given" and refuse rather than guess.
- The command reads a manifest from the conventional location when
  `--manifest` is absent, like `validate-plan` and unlike `push`. The
  asymmetry holds: discovery decides what is *read*, and here a wrong manifest
  fails the tree comparison rather than reaching GitHub.
