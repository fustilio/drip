# Locate drip.db via `git rev-parse --git-path`, not `<repoRoot>/.git`

`openStore` used to join `repoRoot`, `.git`, `drip.db` directly. In a linked git worktree, `<repoRoot>/.git` is a text file (a gitdir pointer), not a directory — opening `drip.db` inside it fails outright (GitHub issue #1).

Fixed by shelling out to `git rev-parse --git-path drip.db`, run with `cwd: repoRoot`. Git resolves `--git-path` relative to the *effective* gitdir for that working tree — for a linked worktree that's its private directory under `.git/worktrees/<name>/`, not the main repo's `.git`. This is exactly the isolation drip wants: overrides, correspondence, timing, and build-cache state are working-tree-local concerns (a worktree can be on a different branch/commit than the main checkout), so each worktree getting its own `drip.db` is correct, not a limitation to work around.

`git rev-parse --git-path` can return either a relative or an absolute path depending on how the repo/worktree is laid out, so the result is joined with `repoRoot` only when relative (`isAbsolute` check in `store.ts`).
