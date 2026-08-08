# Slice correspondence key: symbol signature, not ordinal or content hash

`drip push` needs to know whether a slice from this run is "the same slice" as one it already opened a PR for — otherwise every re-run opens duplicate PRs. Content-addressing (hashing the normalised diff) is explicitly M3 scope and isn't built yet, and keying by ordinal position (`slice0`, `slice1`, ...) is fragile: inserting a new slice earlier in topological order silently reassigns every later ordinal to a different PR.

For M2, correspondence is keyed by a **symbol signature**: the sorted, joined list of `file::QualifiedSymbolPath` group-keys the slice unions together. It's cheap to compute now (the grouping keys already exist), more stable than ordinal position across most edits, and gets naturally superseded once M3's real content-addressing lands — this is a deliberately intermediate solution, not a permanent one.

Known gap: if a slice's *symbol composition* changes (a hunk's enclosing symbol changes, or a hunk moves to a different slice), its signature changes too and correspondence is lost — a new PR opens rather than the old one updating. Accepted for M2; revisit at M3.
