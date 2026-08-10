import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, git, makeTempRepo } from "./test-helpers";

// drip ships two ways: from a checkout via `bun link`, and as a `bun build
// --compile` binary. Only the first is exercised by every other test file,
// and the difference between them is exactly where drip's tree-sitter wasm
// comes from — a real node_modules, or the binary's embedded filesystem. That
// asymmetry is what broke before (docs/adr/0031): `require.resolve` returned a
// path into a filesystem nothing had written, and the compiled binary aborted
// inside emscripten on the first .ts file it tried to parse, while every test
// stayed green. So compile drip here and plan a repo with it, out of process.

let binDir: string;
let bin: string;
let repoRoot: string;
let cleanupRepo: () => void;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "drip-compile-test-"));
  bin = join(binDir, "drip");
  execFileSync("bun", ["build", "--compile", "src/cli.ts", "--outfile", bin], {
    cwd: join(import.meta.dir, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-compile-repo-"));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "src", "helper.ts"), `export function shared(x: number) {\n  return x + 2;\n}\n`);
  writeFileSync(join(repoRoot, "src", "a.ts"), `import { shared } from "./helper";\n\nexport function featureA() {\n  return shared(1);\n}\n`);
  commit(repoRoot, "feature");
});

afterAll(() => {
  cleanupRepo();
  rmSync(binDir, { recursive: true, force: true });
});

// Run from a directory that is neither drip's checkout nor the target repo, so
// nothing on the resolution path can reach a node_modules by accident.
function runBin(args: string[]): string {
  return execFileSync(bin, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();
}

test("the compiled binary parses TypeScript, so its wasm assets are embedded and reachable", () => {
  const plan = JSON.parse(runBin(["plan", "feature", "--base", "main", "--repo", repoRoot, "--json"]));

  // A grammar that fails to load doesn't throw — every hunk quietly falls back
  // to a per-file group (docs/adr/0015), which is what silent wasm breakage
  // looks like from outside. So assert the things only a real parse produces:
  // named symbols, no fallbacks, and a def-use edge across two files.
  expect(plan.slices.flatMap((s: { symbols: string[] }) => s.symbols).sort()).toEqual(["featureA", "shared"]);
  expect(plan.slices.every((s: { fallback: string | null }) => s.fallback === null)).toBe(true);
  expect(plan.fallbackGroups).toEqual([]);
  expect(plan.edges.length).toBeGreaterThan(0);
});

test("the compiled binary's plan matches the same plan run from source", () => {
  const fromBinary = runBin(["plan", "feature", "--base", "main", "--repo", repoRoot, "--json"]);
  const fromSource = execFileSync("bun", ["src/cli.ts", "plan", "feature", "--base", "main", "--repo", repoRoot, "--json"], {
    cwd: join(import.meta.dir, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

  expect(JSON.parse(fromBinary)).toEqual(JSON.parse(fromSource));
});
