# Embed the tree-sitter WASM assets rather than resolving them from node_modules

`docs/adr/0012` moved grammar resolution off the CWD and onto `createRequire(import.meta.url)`, which fixed the global-install case and explicitly left one open: a `bun build --compile` single binary, where there is no `node_modules` to resolve into at all. This closes it.

`require.resolve` needs a real directory tree. A compiled binary's module graph lives in an embedded filesystem, so `requireFromHere.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm")` returns a `/$bunfs/root/...` path that nothing ever wrote, and the first `.ts` file drip tries to parse aborts inside emscripten with `ENOENT`. The failure is not confined to grammars: `Parser.init()` loads web-tree-sitter's own runtime wasm through the same mechanism, so the binary died before reaching a grammar at all.

Both are now static imports with `with { type: "file" }`, which yields a path string the bundler tracks as an asset: the installed file's path when running from source, a path into the embedded filesystem once compiled. One expression covers both distributions, so there is no build-mode branch to keep in sync and no way for the compiled path to rot untested while the source path works. Emscripten finds the runtime the same way, via `Parser.init({ locateFile: () => runtimeWasm })`.

This is sound precisely because these four files are **drip's** assets and never the target repo's — the same reasoning as 0012, one step further. A wasm path was already something drip resolved for itself rather than discovered in the repo being planned; making it an import states that at the module boundary instead of at a call site.

`bun-types` ships ambient declarations for the other asset extensions (`*.txt`, `*.toml`, `*.html`) but not `*.wasm`, since a bare wasm import is an instantiated module rather than a path. `src/wasm.d.ts` declares the `type: "file"` shape drip uses.

**The binary is not self-contained, and the README says so.** It embeds the bun runtime and drip's wasm, which is what the compile step is for, but `git` and `gh` are still spawned, and `verify`'s default build check is `bunx tsc --noEmit` — bun on PATH for the one command that shells back into it. Compiling removes the dependency on a checkout, not on the tools drip drives.
