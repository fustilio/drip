import { execFileSync } from "node:child_process";
import { DripError } from "./errors";

// `gh pr create` prints just the created PR's URL on stdout on success —
// verified against `gh pr create --help` before writing this, no --json flag
// exists for `create` (only for `view`/`list`).
export function ghCreatePr(opts: { repoRoot: string; base: string; head: string; title: string; body: string }): { number: number; url: string } {
  let out: string;
  try {
    out = execFileSync(
      "gh",
      ["pr", "create", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body],
      { cwd: opts.repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } catch (e: any) {
    const stderr = String(e.stderr ?? e.message ?? "");
    throw new DripError(`gh pr create failed for ${opts.head} -> ${opts.base}: ${stderr.trim()}`);
  }
  const url = out.trim().split("\n").pop()!.trim();
  const match = url.match(/\/pull\/(\d+)/);
  return { number: match ? Number(match[1]) : 0, url };
}

export function ghPrComment(repoRoot: string, prNumber: number, body: string): void {
  try {
    execFileSync("gh", ["pr", "comment", String(prNumber), "--body", body], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new DripError(`gh pr comment failed for #${prNumber}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
}

export function ghPrClose(repoRoot: string, prNumber: number, comment: string): void {
  try {
    execFileSync("gh", ["pr", "close", String(prNumber), "--comment", comment], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new DripError(`gh pr close failed for #${prNumber}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
}

export type ReviewComment = {
  id: number;
  path: string;
  line: number | null;
  originalLine: number | null;
  side: "LEFT" | "RIGHT";
  inReplyToId: number | null;
  body: string;
};

// Line-anchored review comments (not issue-level PR comments) — these are
// what goes stale when a force-push rewrites the SHA they're pinned to.
export function ghListReviewComments(repoRoot: string, prNumber: number): ReviewComment[] {
  let out: string;
  try {
    out = execFileSync(
      "gh",
      ["api", `repos/{owner}/{repo}/pulls/${prNumber}/comments`, "--paginate", "--jq", "."],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } catch (e: any) {
    throw new DripError(`gh api pulls/comments failed for #${prNumber}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  // --paginate concatenates one JSON array per page back-to-back, not one array.
  const arrays = trimmed
    .split(/(?<=\])\s*(?=\[)/)
    .map((s) => JSON.parse(s) as any[]);
  return arrays.flat().map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line ?? null,
    originalLine: c.original_line ?? null,
    side: c.side ?? "RIGHT",
    inReplyToId: c.in_reply_to_id ?? null,
    body: c.body ?? "",
  }));
}

export function ghReplyToReviewComment(repoRoot: string, prNumber: number, commentId: number, body: string): void {
  try {
    execFileSync(
      "gh",
      ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${prNumber}/comments/${commentId}/replies`, "-f", `body=${body}`],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e: any) {
    throw new DripError(`gh api reply failed for comment ${commentId}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
}

export function ghPrState(repoRoot: string, prNumber: number): "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN" {
  try {
    const out = execFileSync("gh", ["pr", "view", String(prNumber), "--json", "state", "--jq", ".state"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return out === "OPEN" || out === "CLOSED" || out === "MERGED" ? out : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
