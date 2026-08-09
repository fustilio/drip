import { createHash } from "node:crypto";
import { groupKeyOf, type Hunk } from "./planner";

// See docs/adr/0006-slice-correspondence-key.md. Uses the planner's own group
// key so a fallback group's identity is its deterministic per-file selector,
// not a `file::?` placeholder shared by everything tree-sitter missed.
export function computeSliceSignature(hunks: Hunk[]): string {
  const parts = [...new Set(hunks.map(groupKeyOf))].sort();
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

// Content hash of the slice's actual patch text — distinct from the
// symbol-signature above. Unchanged hash across runs means the diff itself
// didn't change (M3: push skip / M5: build-cache skip).
export function computeContentHash(patch: string): string {
  return createHash("sha1").update(patch).digest("hex").slice(0, 12);
}
