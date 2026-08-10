import type { Database } from "bun:sqlite";
import { getCorrespondence } from "./store";

// drip's ref namespace, and the one rule for finding a unit's branch.
//
// This lives on its own rather than in push.ts because three modules need to
// name a branch and none of them push: `discover` is read-only by construction
// (docs/adr/0027 makes the same point about review-context), `materialize`
// stops at the local repository (docs/adr/0022), and `adopt` writes only
// correspondence. Importing the module that force-pushes in order to build a
// string put the heaviest dependency in the codebase behind three of its
// lightest surfaces.

/** The branch drip mints for a unit it owns. */
export const dripBranchName = (branch: string, label: string) => `drip/${branch}/${label}`;

/**
 * Where a unit's branch actually lives. Normally drip's own name, but a
 * projection bound to an adopted PR keeps the handcrafted branch that PR is
 * already on — including when a *dependent's* base is computed from it, which
 * is why this resolves through correspondence rather than recomputing the name
 * (docs/adr/0020).
 *
 * Deliberately not used by `drip materialize`, which always writes to drip's
 * own ref: quietly overwriting a local copy of someone else's branch is the
 * accident that command exists to prevent (docs/adr/0022).
 */
export function unitBranchName(db: Database, branch: string, signature: string, label: string): string {
  return getCorrespondence(db, branch, signature)?.sliceBranch ?? dripBranchName(branch, label);
}
