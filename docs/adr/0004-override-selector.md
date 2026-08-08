# Override persistence keyed by qualified symbol path, not position

Overrides (`force_merge`, `force_split`) are keyed by `file::QualifiedSymbolPath` (dot-joined tree-sitter ancestor definition names, e.g. `UserService.getUser`), not by line ranges or hunk indices. Line numbers shift on every regeneration; symbol paths are comparatively stable across most edits.

Using the full ancestor chain (rather than the bare leaf name M0 used) also fixes a real ambiguity: two same-named symbols in different scopes of the same file — e.g. a top-level `handler` and a class method also named `handler` — collided under M0's bare-name grouping key. That's tolerable in a throwaway spike; it becomes a real bug once an override durably targets one of them.

If a symbol is renamed or moved, its override silently stops applying. This is a known, accepted gap for M1 — no fuzzy relocation — not solved until the anchor system in M4.
