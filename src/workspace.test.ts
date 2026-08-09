import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeWorkspaceChecks, discoverWorkspaceChecks, isCodeFile } from "./workspace";

// issue #14: the per-slice build check used to vanish silently in any workspace
// without a root tsconfig, which is most of them. These tests are about what
// drip is willing to run unprompted versus what it only ever offers.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "drip-workspace-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const pkg = (o: object) => JSON.stringify(o);

test("a root tsconfig still means tsc --noEmit, unchanged", () => {
  const root = scratch({ "tsconfig.json": "{}", "package.json": pkg({ name: "app" }) });
  const checks = discoverWorkspaceChecks(root);
  expect(checks.rootCommand).toEqual({ command: "bunx tsc --noEmit", source: "root-tsconfig" });
});

test("no root tsconfig, but the repo names its own typecheck script — drip runs that", () => {
  const root = scratch({
    "package.json": pkg({ name: "monorepo", scripts: { typecheck: "turbo run typecheck" } }),
    "pnpm-lock.yaml": "",
  });
  const checks = discoverWorkspaceChecks(root);
  expect(checks.rootCommand).toEqual({ command: "pnpm run typecheck", source: "root-script" });
});

test("a root `test` script is not a typecheck substitute — drip picks no root command", () => {
  const root = scratch({ "package.json": pkg({ name: "monorepo", scripts: { test: "vitest" } }) });
  expect(discoverWorkspaceChecks(root).rootCommand).toBeNull();
});

test("package-level scripts are offered, never composed into something drip runs", () => {
  const root = scratch({
    "package.json": pkg({ name: "monorepo", workspaces: ["packages/*"] }),
    "bun.lock": "",
    "packages/api/package.json": pkg({ name: "@acme/api", scripts: { typecheck: "tsc --noEmit", test: "bun test" } }),
    "packages/api/tsconfig.json": "{}",
    "packages/web/package.json": pkg({ name: "@acme/web", scripts: { typecheck: "tsc --noEmit" } }),
    "packages/docs/package.json": pkg({ name: "@acme/docs" }),
  });
  const checks = discoverWorkspaceChecks(root);

  // The thing issue #14 is about: two packages can typecheck, and drip still
  // refuses to invent a whole-repo command out of them.
  expect(checks.rootCommand).toBeNull();
  expect(checks.packageManager).toBe("bun");
  expect(checks.packageCommands).toEqual([
    "bun run --filter @acme/api typecheck",
    "bun run --filter @acme/api test",
    "bun run --filter @acme/web typecheck",
  ]);
  expect(checks.packages.find((p) => p.dir === "packages/api")!.hasTsconfig).toBe(true);
  expect(describeWorkspaceChecks(checks).join("\n")).toContain("@acme/api");
});

test("node_modules is not a workspace", () => {
  const root = scratch({
    "package.json": pkg({ name: "app" }),
    "node_modules/left-pad/package.json": pkg({ name: "left-pad", scripts: { test: "true" } }),
  });
  expect(discoverWorkspaceChecks(root).packages).toEqual([]);
});

test("a repo with no package.json and no tsconfig isn't a JS workspace, and says nothing", () => {
  const root = scratch({ "main.go": "package main\n" });
  const checks = discoverWorkspaceChecks(root);
  expect(checks.isJsWorkspace).toBe(false);
  expect(checks.rootCommand).toBeNull();
  expect(describeWorkspaceChecks(checks)).toEqual([]);
});

test("an unparseable package.json is a reporting gap, not a crash", () => {
  const root = scratch({ "package.json": "{ not json", "packages/a/package.json": "{ also not json" });
  const checks = discoverWorkspaceChecks(root);
  expect(checks.rootCommand).toBeNull();
  expect(checks.packages.map((p) => p.dir)).toEqual(["packages/a"]);
  expect(checks.packages[0]!.scripts).toEqual([]);
});

test("isCodeFile covers what a typecheck would, including extensions the planner can't parse", () => {
  for (const f of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"]) expect(isCodeFile(f)).toBe(true);
  for (const f of ["README.md", "package.json", "bun.lock", "styles.css", "a.py"]) expect(isCodeFile(f)).toBe(false);
});
