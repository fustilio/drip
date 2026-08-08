import { execFileSync } from "node:child_process";

export type Env = NodeJS.ProcessEnv;
export type CommitInfo = {
  sha: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
};

export interface GitBackend {
  showToplevel(cwd: string): string;
  revParse(ref: string, cwd: string): string;
  mergeBase(a: string, b: string, cwd: string): string;
  diff(a: string, b: string, cwd: string): string;
  show(ref: string, path: string, cwd: string): string;
  readTree(treeish: string, cwd: string, env: Env): void;
  applyCached(patchFile: string, cwd: string, env: Env): void;
  writeTree(cwd: string, env: Env): string;
  commitTree(tree: string, parents: string[], message: string, cwd: string, env?: Env): string;
  worktreeAdd(path: string, commitish: string, cwd: string): void;
  worktreeRemove(path: string, cwd: string): void;
  log(range: string, cwd: string): CommitInfo[];
  updateRef(ref: string, sha: string, cwd: string): void;
}

function run(args: string[], cwd: string, env: Env = process.env): string {
  // Bun's execFileSync inherits stderr live by default (unlike Node's pure
  // pipe-and-capture) — force it to pipe so failed git calls don't dump raw
  // "fatal: ..." noise before our own clean error message.
  return execFileSync("git", args, { cwd, env, maxBuffer: 1024 * 1024 * 64, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

// Every method here is plain node:child_process + git plumbing — no Bun-specific
// API. See docs/adr/0005-git-backend-boundary.md.
export class ShellGitBackend implements GitBackend {
  showToplevel(cwd: string) {
    return run(["rev-parse", "--show-toplevel"], cwd).trim();
  }
  revParse(ref: string, cwd: string) {
    return run(["rev-parse", ref], cwd).trim();
  }
  mergeBase(a: string, b: string, cwd: string) {
    return run(["merge-base", a, b], cwd).trim();
  }
  diff(a: string, b: string, cwd: string) {
    return run(["diff", "-U3", a, b], cwd);
  }
  show(ref: string, path: string, cwd: string) {
    return run(["show", `${ref}:${path}`], cwd);
  }
  readTree(treeish: string, cwd: string, env: Env) {
    run(["read-tree", treeish], cwd, env);
  }
  applyCached(patchFile: string, cwd: string, env: Env) {
    run(["apply", "--cached", "--recount", patchFile], cwd, env);
  }
  writeTree(cwd: string, env: Env) {
    return run(["write-tree"], cwd, env).trim();
  }
  commitTree(tree: string, parents: string[], message: string, cwd: string, env?: Env) {
    const args = ["commit-tree", tree];
    for (const p of parents) args.push("-p", p);
    args.push("-m", message);
    return run(args, cwd, env ?? process.env).trim();
  }
  worktreeAdd(path: string, commitish: string, cwd: string) {
    run(["worktree", "add", "--quiet", "--detach", path, commitish], cwd);
  }
  worktreeRemove(path: string, cwd: string) {
    run(["worktree", "remove", "--force", path], cwd);
  }
  log(range: string, cwd: string): CommitInfo[] {
    const SEP = "\x1e";
    const REC = "\x1d";
    const out = run(
      ["log", "--reverse", `--pretty=format:%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%B${REC}`, range],
      cwd,
    );
    return out
      .split(REC)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [sha, parents, authorName, authorEmail, authorDate, message] = rec.split(SEP);
        return {
          sha: sha!,
          parents: (parents ?? "").split(" ").filter(Boolean),
          authorName: authorName ?? "",
          authorEmail: authorEmail ?? "",
          authorDate: authorDate ?? "",
          message: message ?? "",
        };
      });
  }
  updateRef(ref: string, sha: string, cwd: string) {
    run(["update-ref", ref, sha], cwd);
  }
}
