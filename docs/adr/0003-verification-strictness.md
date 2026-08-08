# Verification strictness: build-check only, no test-pass

M1's per-slice check runs a build/typecheck (`bunx tsc --noEmit` by default, `--build-cmd` to override) in a `git worktree` per slice, applied cumulatively in topological order. It does not run the target repo's test suite.

The plan's invariant language ("every slice builds and passes tests standalone") is aspirational for the finished tool. M1 explicitly scopes down to build-only. Test-pass is a stricter verification mode to add later once build-check has proven itself useful.
