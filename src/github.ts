import { execFileSync } from "node:child_process";
import { DripError } from "./errors";

// `gh pr create` prints just the created PR's URL on stdout on success —
// verified against `gh pr create --help` before writing this, no --json flag
// exists for `create` (only for `view`/`list`).
//
// `draft` is a *creation* option and nothing else: there is no `gh pr edit
// --draft`, and flipping an existing PR's state is a review decision drip has
// no business making (docs/adr/0022).
export function ghCreatePr(opts: { repoRoot: string; base: string; head: string; title: string; body: string; draft?: boolean }): { number: number; url: string } {
  let out: string;
  try {
    out = execFileSync(
      "gh",
      ["pr", "create", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body, ...(opts.draft ? ["--draft"] : [])],
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

// Re-targets an existing PR. Needed when a slice's chosen base changes between
// runs — switching `--projection`, or a prerequisite dropping out of the plan —
// so the PR keeps showing only its own slice's diff instead of everything back
// to the base branch.
export function ghPrSetBase(repoRoot: string, prNumber: number, base: string): void {
  try {
    execFileSync("gh", ["pr", "edit", String(prNumber), "--base", base], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new DripError(`gh pr edit --base failed for #${prNumber}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
}

export function ghPrClose(repoRoot: string, prNumber: number, comment: string): void {
  try {
    execFileSync("gh", ["pr", "close", String(prNumber), "--comment", comment], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new DripError(`gh pr close failed for #${prNumber}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
}

export type PrRef = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  headRefName: string;
  baseRefName: string;
  title: string;
};

// Everything adoption needs to know about an existing PR (issue #11): is it
// still open, which branch is it on, and what does it currently target. Read
// live on every adopt run rather than cached, since the base is the one field
// a human is expected to change out-of-band between runs.
export function ghPrView(repoRoot: string, prNumber: number): PrRef {
  let out: string;
  try {
    out = execFileSync("gh", ["pr", "view", String(prNumber), "--json", "number,url,state,headRefName,baseRefName,title"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e: any) {
    throw new DripError(`gh pr view failed for #${prNumber}: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
  const raw = JSON.parse(out) as Record<string, unknown>;
  const state = String(raw.state ?? "");
  return {
    number: Number(raw.number ?? prNumber),
    url: String(raw.url ?? ""),
    state: state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "UNKNOWN",
    headRefName: String(raw.headRefName ?? ""),
    baseRefName: String(raw.baseRefName ?? ""),
    title: String(raw.title ?? ""),
  };
}

export type PrSummary = { number: number; url: string; title: string; headRefName: string; baseRefName: string };

// Every open PR, for adoption discovery (issue #17). Read-only, and the only
// thing discovery uses GitHub for: which branches currently have a live review
// surface. What a projection *is* is then decided against git trees, never
// against anything in this list.
export function ghListOpenPrs(repoRoot: string, limit = 50): PrSummary[] {
  let out: string;
  try {
    out = execFileSync(
      "gh",
      ["pr", "list", "--state", "open", "--limit", String(limit), "--json", "number,url,title,headRefName,baseRefName"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } catch (e: any) {
    throw new DripError(`gh pr list failed: ${String(e.stderr ?? e.message ?? "").trim()}`);
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  return (JSON.parse(trimmed) as any[]).map((p) => ({
    number: Number(p.number),
    url: String(p.url ?? ""),
    title: String(p.title ?? ""),
    headRefName: String(p.headRefName ?? ""),
    baseRefName: String(p.baseRefName ?? ""),
  }));
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
