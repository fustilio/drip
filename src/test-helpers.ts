import { mock, type Mock } from "bun:test";
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

type AnyMock = Mock<(...args: any[]) => any>;

/**
 * The complete `./github` surface, for `mock.module("./github", () => githubMock({...}))`.
 *
 * Every export, every time, with the caller's own mocks spread over the top.
 * Bun's module mocks are global to the test *process*, so a partial one leaves
 * module evaluation order to decide whether some other file's
 * `import { ghX } from "./github"` resolves at all — four suites each mocked a
 * different subset, and a change to an unrelated import graph was enough to
 * make anchors.ts fail to load in whichever suite happened to evaluate it
 * first. Filling in the whole surface makes that unorderable.
 */
export function githubMock(overrides: Record<string, AnyMock> = {}): Record<string, AnyMock> {
  return {
    ghCreatePr: mock((_opts: unknown) => ({ number: 42, url: "https://example.com/pull/42" })),
    ghPrComment: mock(() => {}),
    ghPrSetBase: mock(() => {}),
    ghPrClose: mock(() => {}),
    ghPrView: mock(() => ({ number: 42, url: "https://example.com/pull/42", state: "OPEN", headRefName: "", baseRefName: "main" })),
    ghDefaultBranch: mock(() => "main"),
    ghListOpenPrs: mock(() => []),
    ghListReviewComments: mock(() => []),
    ghReplyToReviewComment: mock(() => {}),
    ghPrState: mock(() => "OPEN"),
    ghListStacks: mock(() => []),
    ghStackExtensionAvailable: mock(() => false),
    ghStackLink: mock(() => {}),
    ghUnstack: mock(() => {}),
    ghStackUnstack: mock(() => {}),
    ghCreateStack: mock((_repoRoot: string, prNumbers: number[]) => ({
      number: 1,
      url: "https://example.com/stacks/1",
      base: "main",
      open: true,
      prs: prNumbers.map((n) => ({ number: n, state: "open", draft: false, merged: false, headRef: "" })),
    })),
    ghAddToStack: mock(() => ({ number: 1, url: "https://example.com/stacks/1", base: "main", open: true, prs: [] })),
    ...overrides,
  };
}
