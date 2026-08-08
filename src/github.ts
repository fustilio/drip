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
