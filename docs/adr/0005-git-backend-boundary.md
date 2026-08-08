# Runtime boundary: GitBackend interface, already Node-portable

All git access moves behind a `GitBackend` interface (`revParse`, `mergeBase`, `diff`, `show`, `readTree`, `applyCached`, `writeTree`, `commitTree`, `worktreeAdd`/`worktreeRemove`, `log`, `updateRef`), implemented by `ShellGitBackend` via `node:child_process.execFileSync`.

This is already Bun/Node-portable — no rewrite was needed to satisfy the "no Bun-specific APIs in planner core" constraint, since `execFileSync` and `web-tree-sitter`'s WASM loading both run unmodified under plain Node. The only Bun-specific surface in the whole codebase is `bun:sqlite`, and it's confined to `src/store.ts` behind a narrow query interface — that's the actual insurance this ADR was asking for.
