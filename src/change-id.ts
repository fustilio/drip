import { randomBytes } from "node:crypto";
import type { GitBackend } from "./git-backend";

const TRAILER_KEY = "Change-Id";
const TRAILER_RE = new RegExp(`^${TRAILER_KEY}: I[0-9a-f]{40}$`, "m");

export function hasChangeId(message: string): boolean {
  return TRAILER_RE.test(message);
}

// Gerrit-style "I" + 40 hex chars. Real Gerrit derives this from tree/parent/
// author/etc; a random 20-byte id has equivalent uniqueness for drip's needs
// and is simpler.
export function generateChangeId(): string {
  return "I" + randomBytes(20).toString("hex");
}

// Rewrites every commit in mergeBase..branch to carry a Change-Id trailer,
// then moves the branch ref to the new tip. Only ever called from an explicit
// `--assign-ids` flag — see docs/adr/0001-change-id-trailer.md.
export function assignChangeIds(
  git: GitBackend,
  repoRoot: string,
  branch: string,
  baseBranch: string,
): { rewritten: Array<{ old: string; new: string }>; headSha: string } {
  const mergeBase = git.mergeBase(baseBranch, branch, repoRoot);
  const commits = git.log(`${mergeBase}..${branch}`, repoRoot); // oldest first
  const rewritten: Array<{ old: string; new: string }> = [];
  let parent = mergeBase;

  for (const c of commits) {
    const needsTrailer = !hasChangeId(c.message);
    const parentChanged = c.parents[0] !== parent;

    if (!needsTrailer && !parentChanged) {
      // Nothing about this commit or its ancestry changed — reuse it as-is
      // rather than minting a new SHA (and losing nothing idempotency-wise).
      parent = c.sha;
      continue;
    }

    const message = needsTrailer ? `${c.message.replace(/\n+$/, "")}\n\n${TRAILER_KEY}: ${generateChangeId()}\n` : c.message;
    const tree = git.revParse(`${c.sha}^{tree}`, repoRoot);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: c.authorName,
      GIT_AUTHOR_EMAIL: c.authorEmail,
      GIT_AUTHOR_DATE: c.authorDate,
    };
    const newSha = git.commitTree(tree, [parent], message, repoRoot, env);
    rewritten.push({ old: c.sha, new: newSha });
    parent = newSha;
  }

  git.updateRef(`refs/heads/${branch}`, parent, repoRoot);
  return { rewritten, headSha: parent };
}
