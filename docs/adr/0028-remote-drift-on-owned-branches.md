# 0028 — Remote drift on branches drip owns

Status: accepted
Context: found while writing docs/review-feedback-loop.md

## Problem

drip decided what to do with an existing PR by comparing a content hash it
computed now against the one it recorded last time. Both sides of that
comparison are drip's own materialization — `contentHash` covers the slice's
patch, the tree of the commit drip just built, and the ref it targets. Nothing
in it reads the branch that reviewers are actually looking at.

So a commit pushed onto a **drip-owned** branch between two runs produced one of
two outcomes, neither of them reported:

- drip's plan had moved → status `updated` → plain `--force` push. The commit
  was gone, and nothing said so.
- drip's plan had not moved → status `unchanged` → nothing pushed at all. The
  commit stayed on a branch that no longer matched the projection drip believed
  was there, under a status whose own code comment read "the PR is already
  right".

The second is the worse of the two: drip reports agreement it hasn't checked.
The same blindness applied to a branch someone *deleted* — correspondence still
named it, `unchanged` still claimed the PR was fine.

An **adopted** branch already had the right behaviour (docs/adr/0020):
`--force-with-lease` against the recorded sha, so a reviewer's commit blocks the
push rather than vanishing. The asymmetry wasn't a decision anyone made. It came
from `ShellGitBackend.push`, whose comment argued a lease would misfire on
branches drip owns "because drip never fetches to keep a remote-tracking ref
current" — true of bare `--force-with-lease`, which consults that ref, and not
true of the explicit `--force-with-lease=<ref>:<expect>` form the adopted path
had been using all along.

## Decision

Read the remote once per run, and never decide `unchanged` without it.

`GitBackend.lsRemoteHeads(remote, cwd)` returns every `refs/heads/*` and its
sha — one round trip for the whole run, no objects fetched, sha comparison only.
For any unit with recorded correspondence, `push` compares the remote's tip
against the sha drip last wrote and acts on the difference:

| Situation | drip-owned branch | adopted branch |
|---|---|---|
| Remote tip == recorded sha | proceed as before | proceed as before |
| Remote tip differs | `blocked`, naming both shas; `--reclaim` overwrites | `blocked`; re-run `manifest adopt` |
| Branch absent from remote | recreated from the projection, reported in the note | `blocked`; restore it or `manifest forget` |

The rule underneath the table: **discarding a commit drip didn't write needs
permission; recreating drip's own branch doesn't.** Putting back a branch drip
opened, from the projection it opened it for, destroys nothing and needs no
flag. Overwriting someone's commit destroys something, and needs `--reclaim`.
An adopted branch has no `--reclaim` — drip doesn't own it, and no flag on
drip's side makes discarding someone else's commit safe.

Every branch with a recorded sha is now pushed under a lease, drip's own
included. The ls-remote check is what produces a good error message; the lease
is what closes the window between that read and the push itself, so the two are
not redundant.

## Consequences

- **`push` now requires the network before it decides anything.** It needed it
  to push regardless. A failure is fatal in real mode on purpose: silently
  skipping this check immediately before a force-push is the bug being fixed.
- **`--dry-run` degrades instead of failing.** A dry-run is expected to work
  offline, so an unreachable remote leaves drift `unknown` and every affected
  result says the check didn't run — rather than a clean preview that quietly
  checked nothing.
- **`unchanged` means more than it did.** It now asserts that the branch on the
  remote is the one drip last wrote, which is what readers already assumed it
  meant.
- **A new way for a run to be blocked**, and it will fire on real workflows —
  pushing a review fix straight onto a PR branch is a normal thing to do. That
  is the intended outcome: the fix belongs in the mega branch, and drip now says
  so instead of choosing silently between two wrong answers.
- **One extra `ls-remote` per run.** Not per projection.
- The stale reasoning in `ShellGitBackend.push` is corrected in place, since it
  actively argued for the behaviour this ADR removes.

## Alternatives rejected

- **Fetch the branches and compare trees.** Strictly more information — drip
  could tell "someone pushed an unrelated commit" from "someone pushed exactly
  what drip was about to". It costs a real fetch per branch, and the answer
  doesn't change: either way the branch is not what drip recorded, and the
  question of whose commit it is belongs to a person.
- **Fold the remote tip into `contentHash`.** Would make drift look like a
  content change, so the branch would be quietly force-pushed back into shape —
  the blind overwrite again, with extra steps.
- **Lease every push and let the failure be the report.** Nearly free, but the
  error a lease produces is git's, arriving with no idea whether the branch is
  adopted, drip-owned, or missing. The pre-check is what makes the three cases
  distinguishable and the message actionable.
