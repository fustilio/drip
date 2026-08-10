# 0024 — Verification profiles: name the command set once

Status: accepted
Context: issue #19

## Problem

A projection's `verification` commands are executed against its own
materialized tree (docs/adr/0019), which is what turns "this PR is
independently runnable" from a claim into a check. In practice a repository has
two or three real answers — "typecheck the workspace", "run the API package's
tests", "build the docs site" — and every projection in the manifest repeats
one of them verbatim.

Repetition is not just noise. It is how a twelve-projection manifest ends up
with eleven projections running `pnpm -r typecheck` and one running
`pnpm typecheck`, a difference nobody intended, nobody reviewed, and nobody can
see without diffing the strings by eye. It is also why raising the bar for a
whole branch — adding a lint step, switching package manager — is a
twelve-place edit that is easy to do eleven times.

## Decision

A repository may declare **named verification profiles** in a versioned JSON
document, and a projection may reference one by name instead of listing
commands:

```jsonc
// .drip/verification.json
{ "version": 1, "profiles": { "typecheck": { "description": "…", "commands": ["pnpm typecheck"] } } }

// .drip/projections/<branch>.json
{ "id": "report-tab-details", "verificationProfile": "typecheck", … }
```

Four rules, each chosen so the resolution can't become a place where behaviour
hides:

**Resolution is a lookup, not a merge.** A projection that names a profile
*and* lists its own `verification` commands has two answers to "what runs
here", and silently picking either is how a projection ends up running
something its author didn't write. That's a `verification-profile-conflict`
error. Inline commands remain exactly as they were for the one-off case.

**Resolution is visible.** The resolved commands are what the report prints,
the PR body carries, `--require-verification` counts and `runManifestVerification`
executes — everything downstream sees ordinary strings and knows nothing about
profiles. The one place the indirection shows is the report, which names the
profile next to the commands it produced (`verify: pnpm typecheck  (profile:
typecheck)`), so a reader never has to open a second file to learn what runs.

**A missing profile is an error that says where to look.** `unknown-verification-profile`
names the file that was read and the profiles defined in it, or — when the
repository declares none — the path to create and the JSON to put there. And a
malformed profiles document fails on load even if nothing references it:
ignoring it and reporting "unknown profile 'ts'" later would send the reader to
debug the manifest for a typo that is in the profiles file.

**drip never picks a profile for you.** There is no default profile, no
inference from the workspace, no "if there's exactly one, use it". A profile
applies where a projection names it, and nowhere else — the same boundary
docs/adr/0023 draws around discovered workspace commands, for the same reason:
composing a command and then failing someone's push on the result is a guess
with consequences.

## Where it lives

The same two locations as the manifest (docs/adr/0018), in the same order:
`.drip/verification.json` in the working tree, then
`<gitdir>/drip/verification.json` private to the clone. Tracked first, because
a team's verification vocabulary is part of the review plan they keep and argue
about — unlike overrides, which are one person's local boundary corrections and
belong in `.git/drip.db` (docs/adr/0002).

## Consequences

- `ResolvedProjection` gains `verificationProfile: string | null`, exposed in
  `--json` and over MCP, so an external tool can tell a shared command set from
  a projection-specific one.
- Manifests written before this exist are unaffected: no profiles file, no
  `verificationProfile` field, identical behaviour.
- `--require-verification` is satisfied by profile-resolved commands, because
  by the time that rule runs there is no difference left to see.
- Profiles are not scoped, inherited or composed. If that turns out to be
  needed, it should be added deliberately rather than arrived at — the value
  here is that "what runs for this projection" stays a question with one
  lookup and one answer.
