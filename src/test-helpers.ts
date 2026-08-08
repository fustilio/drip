import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared by every test that needs a disposable git repo. Deliberately runs
// real git, not a fake -- faithfully simulating git's own object model
// in-memory is a bigger undertaking than the thing it would test, and a
// buggy fake gives false confidence. See docs/adr/0010-test-against-real-git.md.
export function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export function gitOutput(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export function commit(cwd: string, message: string): void {
  git(["add", "-A"], cwd);
  git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", message], cwd);
}

// A disposable repo with `main` as the initial branch, ready for a caller to
// add files and commit. Caller is responsible for cleanup via the returned
// cleanup() (or its own rmSync — same thing).
export function makeTempRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  git(["init", "-q"], repoRoot);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], repoRoot);
  return { repoRoot, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

// A local bare repo works as a real git remote -- `git push` to it is fully
// real, no network, nothing to fake.
export function makeBareRemote(prefix: string): { remoteRoot: string; cleanup: () => void } {
  const remoteRoot = mkdtempSync(join(tmpdir(), prefix));
  git(["init", "-q", "--bare"], remoteRoot);
  return { remoteRoot, cleanup: () => rmSync(remoteRoot, { recursive: true, force: true }) };
}
