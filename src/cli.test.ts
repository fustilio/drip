import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { commit, git, makeTempRepo } from "./test-helpers";

// The CLI's own contract: which flags each command accepts, what it does with
// them, and what it says when they're wrong. `src/cli.ts` had no direct tests
// before ADR 0029 replaced its one shared flag table with per-command
// declarations — and the thing most worth locking down is exactly what that
// table couldn't express.
//
// Runs the real CLI as a subprocess, so what's under test is the same entry
// point a user types. Parse errors happen before any git work, so most of these
// cost nothing but process startup.

const CLI = join(import.meta.dir, "cli.ts");

let repoRoot: string;
let cleanup: () => void;

async function drip(...args: string[]): Promise<{ code: number; stdout: string; stderr: string; out: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr, out: stdout + stderr };
}

beforeEach(() => {
  ({ repoRoot, cleanup } = makeTempRepo("drip-cli-test-"));
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 1;\n}\n`);
  commit(repoRoot, "init");
  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 2;\n}\n`);
  commit(repoRoot, "feature");
});

afterEach(() => cleanup());

// --- per-command flag scoping: the regression this migration existed to fix ---

test("a flag belonging to another command is rejected, not silently ignored", async () => {
  // Before ADR 0029 this exited 0: one global table meant every command
  // accepted every flag, and `plan --reclaim` looked like it did something.
  const r = await drip("plan", "feature", "--reclaim");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--reclaim");
});

test("--worktree is not offered on push, because push can't act on uncommitted content", async () => {
  const r = await drip("push", "feature", "--worktree");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--worktree");
});

test("--layer is a score flag and nothing else accepts it", async () => {
  expect((await drip("verify", "feature", "--layer", "atomic")).code).not.toBe(0);
  expect((await drip("plan", "feature", "--layer", "atomic")).code).not.toBe(0);
});

// --- the CLI surface didn't change --------------------------------------------

test("kebab-case flags still work, as every README example writes them", async () => {
  const r = await drip("plan", "feature", "--coarsen", "--target-slices", "2");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("SLICES:");
});

test("every documented command is routable", async () => {
  const help = await drip("--help");
  for (const cmd of ["plan", "verify", "push", "validate-plan", "materialize", "review-context", "score", "override", "manifest", "mcp"]) {
    expect(help.out).toContain(cmd);
  }
});

test("override and manifest keep their subcommands", async () => {
  expect((await drip("override", "--help")).out).toMatch(/add.*list.*remove/s);
  expect((await drip("manifest", "--help")).out).toMatch(/adopt.*discover.*list.*forget/s);
});

// --- coercion and validation now happen in the parser -------------------------

test("a non-numeric --target-slices is rejected with the flag named", async () => {
  const r = await drip("plan", "feature", "--coarsen", "--target-slices", "many");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--target-slices must be a whole number");
});

test("--threshold outside 0..1 is rejected", async () => {
  const r = await drip("score", "feature", "--expected", "/nonexistent.json", "--threshold", "99");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--threshold must be a fraction between 0 and 1");
});

test("--limit must be a positive whole number", async () => {
  const r = await drip("manifest", "discover", "feature", "--limit", "0");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--limit must be a positive whole number");
});

test("--pr must be a positive whole number", async () => {
  const r = await drip("manifest", "adopt", "feature", "--projection", "x", "--pr", "-3", "--head", "b");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--pr must be a positive whole number");
});

test("an enum flag lists the values it accepts", async () => {
  const r = await drip("push", "feature", "--projection", "sideways");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("stacked");
  expect(r.out).toContain("flat-first");
});

test("override --kind only accepts the two real kinds", async () => {
  const r = await drip("override", "add", "feature", "--kind", "force_maybe", "--selector-a", "a.ts::a");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("force_merge");
});

// --- required inputs ----------------------------------------------------------

test("score without --expected fails, since there is nothing to measure against", async () => {
  const r = await drip("score", "feature");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("expected");
});

test("manifest adopt requires all three of projection, pr and head", async () => {
  // Two out of three would make the third a guess, and a wrong guess here
  // eventually force-pushes over someone else's branch (docs/adr/0020).
  const r = await drip("manifest", "adopt", "feature", "--projection", "x", "--pr", "7");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("head");
});

// --- behaviour preserved through the migration --------------------------------

test("a branch with no changes reports that and exits 0", async () => {
  const r = await drip("plan", "main", "--base", "main");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("nothing to slice");
});

test("--worktree plans without a branch argument; without either, it says so", async () => {
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 3;\n}\n`);
  const ok = await drip("plan", "--worktree");
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("working tree");

  const missing = await drip("plan");
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain("name the mega branch");
});

test("--assign-ids is refused against a working tree", async () => {
  const r = await drip("plan", "--worktree", "--assign-ids");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("commit first");
});

test("a DripError prints one clean line and no stack trace", async () => {
  const r = await drip("plan", "--worktree", "--assign-ids");
  expect(r.stderr).toStartWith("error: ");
  expect(r.stderr).not.toContain("at <anonymous>");
  expect(r.stderr).not.toContain("Command failed");
});

test("--json prints machine-readable output and nothing else", async () => {
  const r = await drip("plan", "feature", "--json");
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.source).toBeDefined();
  expect(Array.isArray(parsed.slices)).toBe(true);
});

test("push without --yes or --dry-run refuses to touch GitHub", async () => {
  const r = await drip("push", "feature", "--no-build-check");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("--yes");
});

test("--emit-manifest without --coarsen says what it needs", async () => {
  const r = await drip("plan", "feature", "--emit-manifest");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("--coarsen");
});
