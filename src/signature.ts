import { createHash } from "node:crypto";
import type { Hunk } from "./planner";

// See docs/adr/0006-slice-correspondence-key.md.
export function computeSliceSignature(hunks: Hunk[]): string {
  const parts = hunks.map((h) => `${h.file}::${h.qualifiedSymbol ?? "?"}`).sort();
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

// Content hash of the slice's actual patch text — distinct from the
// symbol-signature above. Unchanged hash across runs means the diff itself
// didn't change (M3: push skip / M5: build-cache skip).
export function computeContentHash(patch: string): string {
  return createHash("sha1").update(patch).digest("hex").slice(0, 12);
}
