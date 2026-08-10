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

/**
 * What a ref *name* is, as opposed to what it resolves to. `rev-parse` answers
 * the second question and happily turns a tag, a remote-tracking ref or a raw
 * sha into a commit — which is exactly how a commit sha reached `gh pr create
 * --base` and got rejected there instead of here (docs/adr/0032).
 */
export type RefKind = "branch" | "tag" | "remote" | "commit" | "none";

export interface GitBackend {
  showToplevel(cwd: string): string;
  revParse(ref: string, cwd: string): string;
  /** the checked-out branch, or null when HEAD is detached */
  currentBranch(cwd: string): string | null;
  mergeBase(a: string, b: string, cwd: string): string;
  diff(a: string, b: string, cwd: string): string;
  diffNameStatus(a: string, b: string, cwd: string): Array<{ status: string; path: string }>;
  /** stage every non-ignored change in the working tree into `env`'s index */
  addAll(cwd: string, env: Env): void;
  show(ref: string, path: string, cwd: string): string;
  readTree(treeish: string, cwd: string, env: Env): void;
  applyCached(patchFile: string, cwd: string, env: Env): void;
  applyCachedReverseCheck(patchFile: string, cwd: string, env: Env): boolean;
  writeTree(cwd: string, env: Env): string;
  commitTree(tree: string, parents: string[], message: string, cwd: string, env?: Env): string;
  worktreeAdd(path: string, commitish: string, cwd: string): void;
  worktreeRemove(path: string, cwd: string): void;
  log(range: string, cwd: string): CommitInfo[];
  /** what a name resolves to in this clone — a PR base has to be a branch (docs/adr/0032) */
  refKind(name: string, cwd: string): RefKind;
  updateRef(ref: string, sha: string, cwd: string): void;
  fetch(remote: string, ref: string, cwd: string): void;
  /** every `refs/heads/*` on the remote, keyed by short branch name */
  lsRemoteHeads(remote: string, cwd: string): Map<string, string>;
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
  currentBranch(cwd: string) {
    const out = run(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    return out === "HEAD" ? null : out; // detached
  }
  mergeBase(a: string, b: string, cwd: string) {
    return run(["merge-base", a, b], cwd).trim();
  }
  diff(a: string, b: string, cwd: string) {
    return run(["diff", "-U3", a, b], cwd);
  }
  diffNameStatus(a: string, b: string, cwd: string) {
    return run(["diff", "--name-status", "-z", a, b], cwd)
      .split("\0")
      .filter(Boolean)
      .reduce<Array<{ status: string; path: string }>>((acc, field, i, all) => {
        // -z emits status and path as separate NUL-terminated fields, so the
        // pairing is positional. (Renames add a second path field; drip's
        // parseDiff doesn't handle renames anyway — see plan.excluded.)
        if (i % 2 === 0 && all[i + 1] !== undefined) acc.push({ status: field, path: all[i + 1]! });
        return acc;
      }, []);
  }
  // Runs against the caller's scratch index (GIT_INDEX_FILE in env), never the
  // repo's own — planning the worktree must not stage anything for real. It
  // does write blobs for untracked files into the object database; they are
  // unreferenced and get collected like any other loose object.
  addAll(cwd: string, env: Env) {
    run(["add", "-A"], cwd, env);
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
  // Deliberately name-first: `show-ref --verify` is asked about each full
  // refname in turn, and only a name that is no ref at all falls through to
  // rev-parse. Asking rev-parse first would classify `main` and `deadbeef`
  // identically, since both resolve to a commit.
  refKind(name: string, cwd: string): RefKind {
    const exists = (ref: string) => {
      try {
        run(["show-ref", "--verify", "--quiet", ref], cwd);
        return true;
      } catch {
        return false;
      }
    };
    if (exists(`refs/heads/${name}`)) return "branch";
    if (exists(`refs/tags/${name}`)) return "tag";
    if (exists(`refs/remotes/${name}`)) return "remote";
    try {
      run(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], cwd);
      return "commit";
    } catch {
      return "none";
    }
  }
  updateRef(ref: string, sha: string, cwd: string) {
    run(["update-ref", ref, sha], cwd);
  }
  // Fetches one ref by name into FETCH_HEAD. Used to read an adopted branch
  // that lives on the remote and may have no local ref at all (issue #11).
  fetch(remote: string, ref: string, cwd: string) {
    run(["fetch", remote, ref], cwd);
  }
  // One network round trip for every branch on the remote, so push() can ask
  // "did this branch move since drip last wrote it?" without fetching objects.
  // Sha comparison only — the answer never needs the commit locally, which
  // matters because drip's own materialized commits are unreferenced here.
  lsRemoteHeads(remote: string, cwd: string) {
    const heads = new Map<string, string>();
    for (const line of run(["ls-remote", "--heads", remote], cwd).split("\n")) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref?.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
    }
    return heads;
  }
  push(remote: string, refspec: string, cwd: string, force: boolean, lease?: Lease) {
    // A lease is always the explicit `<ref>:<expect>` form, never bare
    // --force-with-lease: the bare form consults the remote-tracking ref, which
    // drip never fetches to keep current, and would reject pushes to branches
    // drip owns exclusively just because the local view is stale. Given an
    // explicit sha, git compares against the *actual* remote ref, so a lease is
    // meaningful for a drip-owned branch (docs/adr/0028) and an adopted one
    // (docs/adr/0020) alike: the push fails instead of discarding a commit drip
    // never saw. Plain --force remains the path for a branch with no recorded
    // sha to expect — a first push, or one drip has no correspondence for.
    const args = ["push"];
    if (lease) args.push(`--force-with-lease=${lease.ref}:${lease.expect}`);
    else if (force) args.push("--force");
    args.push(remote, refspec);
    run(args, cwd);
  }
}
