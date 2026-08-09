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
  applyCachedReverseCheck(patchFile: string, cwd: string, env: Env): boolean;
  writeTree(cwd: string, env: Env): string;
  commitTree(tree: string, parents: string[], message: string, cwd: string, env?: Env): string;
  worktreeAdd(path: string, commitish: string, cwd: string): void;
  worktreeRemove(path: string, cwd: string): void;
  log(range: string, cwd: string): CommitInfo[];
  updateRef(ref: string, sha: string, cwd: string): void;
  fetch(remote: string, ref: string, cwd: string): void;
  push(remote: string, refspec: string, cwd: string, force: boolean, lease?: Lease): void;
}

/** `--force-with-lease=<ref>:<expect>` — see ShellGitBackend.push. */
export type Lease = { ref: string; expect: string };

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
  // Squash-merge detection: does this slice's content already exist at the
  // scratch index's current tree? A clean reverse-apply means yes.
  applyCachedReverseCheck(patchFile: string, cwd: string, env: Env): boolean {
    try {
      run(["apply", "--check", "--cached", "--reverse", "--recount", patchFile], cwd, env);
      return true;
    } catch {
      return false;
    }
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
  // Fetches one ref by name into FETCH_HEAD. Used to read an adopted branch
  // that lives on the remote and may have no local ref at all (issue #11).
  fetch(remote: string, ref: string, cwd: string) {
    run(["fetch", remote, ref], cwd);
  }
  push(remote: string, refspec: string, cwd: string, force: boolean, lease?: Lease) {
    // Plain --force, not --force-with-lease: drip never fetches to keep a
    // remote-tracking ref current, so lease would reject pushes to branches
    // it itself owns and manages exclusively (the drip/<branch>/sliceN
    // namespace) just because the local repo's view of the remote is stale.
    //
    // An adopted branch (docs/adr/0020) is the exception, and the reasoning
    // inverts: drip does not own it, someone may have pushed a review fix onto
    // it, and the sha drip last saw is a real expectation rather than a stale
    // guess. There a lease is exactly right — the push fails instead of
    // discarding a commit drip never saw.
    const args = ["push"];
    if (lease) args.push(`--force-with-lease=${lease.ref}:${lease.expect}`);
    else if (force) args.push("--force");
    args.push(remote, refspec);
    run(args, cwd);
  }
}
