// drip imports its tree-sitter wasm assets with `with { type: "file" }`, which
// resolves to a path string rather than an instantiated module — the installed
// file's path from source, a path into the embedded filesystem once compiled
// with `bun build --compile`. bun-types declares the other asset extensions
// (*.txt, *.toml, *.html) but not this one, so declare the shape drip uses.
// See docs/adr/0031-embedded-wasm-assets.md.
declare module "*.wasm" {
  const path: string;
  export default path;
}
