# 0027 — Review context: a way to look without touching

Status: accepted
Context: issue #18

## Problem

Everything drip knows about a projection's review surface is spread across
three places that don't talk to each other:

- the **manifest** says what the projection is meant to be (id, intent,
  prerequisites, verification);
- the **store** says which branch and PR it corresponds to, whether drip opened
  that PR or adopted someone else's, what base was recorded, and what content
  was last sent there;
- **GitHub** holds the comments.

Answering the question anyone actually has — *what state is this PR in, and has
the thing underneath it moved since a reviewer last looked?* — means reading a
push report, a `manifest list` line and the PR itself, and joining them by eye.
An external tool (an agent, an editor integration, a dashboard) can't join them
at all: the only surfaces that produce this information are commands whose job
is to change something.

## Decision

`drip review-context <branch> [--projection id]`, and `drip_review_context`
over MCP, join the three and do nothing else.

Per projection it reports:

- **identity** — id, title, intent, prerequisites, size;
- **correspondence** — branch, PR number and URL, whether it was adopted or
  drip-opened, the base recorded at the last push, the base the manifest graph
  implies today, and whether they still agree (computed by the same rule `push`
  uses, so a disagreement reported here is the disagreement a push would report,
  not a second opinion);
- **drift** — whether the projection's current materialized tree matches what
  its PR last received, and when it doesn't, the changed files and the durable
  selectors under them;
- **review** — the open threads on the PR, with reply counts, plus the count of
  comments drip previously failed to relocate and replied to (docs/adr/0007).

Three things are deliberate:

**Read-only is a property of the code, not a promise in the docs.** There is no
path in this module that comments, replies, resolves, pushes, retargets or
records. The only GitHub call is the comment *listing* the anchor system
already uses; the materialization runs in a scratch index exactly as
`validate-plan`'s does. The test suite asserts the mutating GitHub exports are
never called and that neither the remote's refs, the local refs, the
correspondence table nor the anchor table change across a run — because "this
command is safe to run" is the entire value proposition, and a test that only
checked the output wouldn't be testing it.

**"Unknown" is a real answer.** An adopted branch whose recorded sha isn't in
this clone can't be compared without fetching, so the state is reported as
unknown with the reason and the fetch to run. Reporting "changed" there would
be a guess, and a guess in the direction of "you should push" is the expensive
one.

**The report says what it can't know.** GitHub's REST comments endpoint carries
no thread-resolution state — that is GraphQL only — so drip reports "the
threads it can see" and says so in as many words, rather than labelling them
unresolved. `resolutionStateKnown: false` carries that structurally for
consumers. Overstating this would make the command a worse source of truth than
the PR page it exists to summarise.

`--no-review` skips the GitHub read entirely and reports the local half, so the
command still answers offline, in CI, and anywhere `gh` isn't authenticated.

## Consequences

- `collectReviewContext` takes the comment reader as an injected function
  (defaulting to `ghListReviewComments`), which is how the suite exercises the
  reporting without a `gh` binary and how the no-side-effect assertions stay
  honest.
- A missing or unauthenticated `gh` is an ordinary condition, not a failure:
  the review half reports unavailable with the reason and the local half still
  answers.
- The store gains `listCommentAnchors`, a read alongside the existing
  `wasCommentProcessed`/`markCommentProcessed` pair.
- There is deliberately no write counterpart over MCP. Posting a comment or
  resolving a thread from an agent is a different decision with a different
  blast radius, and the same reasoning that keeps `push` and `manifest adopt`
  off the MCP surface (docs/adr/0009) applies to it.
