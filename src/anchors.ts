import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { GitBackend } from "./git-backend";
import { ghListReviewComments, ghReplyToReviewComment } from "./github";
import { parseDiff, type Hunk } from "./planner";
import { markCommentProcessed, wasCommentProcessed } from "./store";

// M4 (conservative cut — see docs/adr/0007-comment-anchor-scope.md): relocate
// only on an exact hunk-hash match (tier 1 of the plan's 3-tier anchor). No
// symbol-path fallback, no fuzzy/AI tier — anything that isn't an exact match
// is orphaned loudly rather than guessed at.
function hunkHash(h: Hunk): string {
  return createHash("sha1").update(h.raw).digest("hex").slice(0, 12);
}

function findHunkAtLine(hunks: Hunk[], line: number): Hunk | null {
  for (const h of hunks) {
    const start = h.newStart;
    const end = h.newStart + Math.max(h.newLines, 1) - 1;
    if (line >= start && line <= end) return h;
  }
  return null;
}

export async function reconcileComments(opts: {
  git: GitBackend;
  db: Database;
  repoRoot: string;
  branch: string;
  sliceSignature: string;
  mergeBase: string;
  oldCommitSha: string;
  newHunks: Hunk[];
  prNumber: number;
}): Promise<{ unchanged: number; orphaned: number }> {
  const { git, db, repoRoot, branch, sliceSignature, mergeBase, oldCommitSha, newHunks, prNumber } = opts;

  const oldDiffText = git.diff(mergeBase, oldCommitSha, repoRoot);
  const oldFiles = parseDiff(oldDiffText);
  const sliceFilePaths = new Set(newHunks.map((h) => h.file));
  const oldHunksByFile = new Map(oldFiles.filter((f) => sliceFilePaths.has(f.path)).map((f) => [f.path, f.hunks]));
  const newHunksByFile = new Map<string, Hunk[]>();
  for (const h of newHunks) {
    const list = newHunksByFile.get(h.file) ?? [];
    list.push(h);
    newHunksByFile.set(h.file, list);
  }

  const comments = ghListReviewComments(repoRoot, prNumber).filter(
    (c) => c.inReplyToId === null && c.side === "RIGHT" && sliceFilePaths.has(c.path) && !wasCommentProcessed(db, c.id),
  );

  let unchanged = 0;
  let orphaned = 0;

  for (const c of comments) {
    const line = c.originalLine ?? c.line;
    const oldHunks = oldHunksByFile.get(c.path) ?? [];
    const oldHunk = line !== null ? findHunkAtLine(oldHunks, line) : null;
    if (!oldHunk) continue; // not inside a hunk this slice owns (e.g. unchanged context line) — nothing to reconcile

    const oldHash = hunkHash(oldHunk);
    const stillPresent = (newHunksByFile.get(c.path) ?? []).some((h) => hunkHash(h) === oldHash);

    if (stillPresent) {
      unchanged++;
      markCommentProcessed(db, c.id, branch, sliceSignature, "unchanged");
    } else {
      ghReplyToReviewComment(
        repoRoot,
        prNumber,
        c.id,
        "⚠️ drip: the code this comment refers to changed in the latest push and couldn't be confidently relocated (no exact match) — needs a fresh look.",
      );
      orphaned++;
      markCommentProcessed(db, c.id, branch, sliceSignature, "orphaned");
    }
  }

  return { unchanged, orphaned };
}
