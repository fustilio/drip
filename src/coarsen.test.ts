import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjections } from "./coarsen";
import { ShellGitBackend } from "./git-backend";
import { computePlan, type PlanResult } from "./planner";
import { openStore } from "./store";
import { commit, git, makeTempRepo } from "./test-helpers";
import { verifyTreeHash } from "./verify";
import { projectedUnits } from "./workflow";

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanupRepo: () => void;

// A miniature version of the shape issue #8 describes: a feature directory
// whose production code, its private helper, its tests, and its top-level
// imports all come out as separate atomic slices, plus unrelated docs and a
// dependency manifest that must stay their own projections.
beforeAll(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-coarsen-test-"));
  mkdirSync(join(repoRoot, "src", "appeals"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "inbox"), { recursive: true });

  const write = (p: string, s: string) => writeFileSync(join(repoRoot, p), s);

  write("package.json", `{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n`);
  write("bun.lock", `lockfileVersion: 1\n`);
  write("README.md", `# fixture\n`);
  write("src/appeals/format.ts", `export function formatAppeal(x: string) {\n  return x;\n}\n`);
  write(
    "src/appeals/report.ts",
    `import { formatAppeal } from "./format";\n\nconst PAD1 = 1;\nconst PAD2 = 2;\nconst PAD3 = 3;\nconst PAD4 = 4;\nconst PAD5 = 5;\nconst PAD6 = 6;\n\nexport function renderReport(x: string) {\n  return formatAppeal(x);\n}\n`,
  );
  write("src/appeals/report.test.ts", `import { renderReport } from "./report";\n\nrenderReport("a");\n`);
  write("src/inbox/columns.ts", `export function columns() {\n  return ["a"];\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  write("package.json", `{\n  "name": "fixture",\n  "version": "2.0.0"\n}\n`);
  write("bun.lock", `lockfileVersion: 2\n`);
  write("README.md", `# fixture\n\nnow documented\n`);
  write("src/appeals/format.ts", `export function formatAppeal(x: string) {\n  return x.trim();\n}\n`);
  write(
    "src/appeals/report.ts",
    `import { formatAppeal, type Appeal } from "./format";\n\nconst PAD1 = 1;\nconst PAD2 = 2;\nconst PAD3 = 3;\nconst PAD4 = 4;\nconst PAD5 = 5;\nconst PAD6 = 6;\n\nexport function renderReport(x: string) {\n  return formatAppeal(x).toUpperCase();\n}\n`,
  );
  write("src/appeals/report.test.ts", `import { renderReport } from "./report";\n\nrenderReport("b");\n`);
  write("src/inbox/columns.ts", `export function columns() {\n  return ["a", "b"];\n}\n`);
  commit(repoRoot, "feature");
});

afterAll(() => cleanupRepo());

async function plan(): Promise<PlanResult> {
  const p = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  expect(p.order).not.toBeNull();
  return p;
}

const projectionFor = (result: ReturnType<typeof computeProjections>, file: string) =>
  result.projections.find((p) => p.files.includes(file))!;

test("coarsening produces fewer projections than atomic slices, and each lists its constituents", async () => {
  const p = await plan();
  const coarse = computeProjections(p);

  expect(coarse.projections.length).toBeLessThan(coarse.atomicSliceCount);
  expect(coarse.projections.flatMap((x) => x.sliceIds).sort()).toEqual([...p.slices.keys()].sort());
  for (const proj of coarse.projections) expect(proj.slices.length).toBeGreaterThan(0);
});

test("a test file rides with the production file it exercises", async () => {
  const coarse = computeProjections(await plan());
  expect(projectionFor(coarse, "src/appeals/report.test.ts").files).toContain("src/appeals/report.ts");
  expect(projectionFor(coarse, "src/appeals/report.test.ts").merges.some((m) => m.rule === "test-affinity")).toBe(true);
});

test("a file's top-level import hunk rides with that file's own symbol slice", async () => {
  const p = await plan();
  // The atomic plan really does split them — otherwise this test proves nothing.
  const importSlice = [...p.fallbackGroups.entries()].find(([, g]) => g.files.includes("src/appeals/report.ts"));
  expect(importSlice).toBeDefined();

  const coarse = computeProjections(p);
  const proj = projectionFor(coarse, "src/appeals/report.ts");
  expect(proj.sliceIds).toContain(importSlice![0]);
  expect(proj.merges.some((m) => m.rule === "same-file")).toBe(true);
});

test("docs and the dependency manifest stay their own projections", async () => {
  const coarse = computeProjections(await plan());
  const docs = projectionFor(coarse, "README.md");
  expect(docs.files).toEqual(["README.md"]);
  expect(docs.fallbackOnly).toBe(true);

  const deps = projectionFor(coarse, "package.json");
  expect(deps.files).toEqual(["bun.lock", "package.json"]);
  expect(deps.fallbackOnly).toBe(true);
});

test("a force_split override is never coarsened away", async () => {
  const pinned = await computePlan({
    git: backend,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    overrides: [{ kind: "force_split", selectorA: "src/appeals/report.test.ts::(file)", selectorB: null, note: null }],
  });
  const coarse = computeProjections(pinned, { targetSlices: 1 });
  const testProj = projectionFor(coarse, "src/appeals/report.test.ts");
  expect(testProj.pinned).toBe(true);
  expect(testProj.files).toEqual(["src/appeals/report.test.ts"]);
  // A target that would require merging the pinned projection is reported as
  // unmet rather than quietly overruling the override.
  expect(coarse.targetMet).toBe(false);
});

test("--target-slices merges by feature directory until the budget is met", async () => {
  const p = await plan();
  const uncapped = computeProjections(p);
  const capped = computeProjections(p, { targetSlices: 3 });

  expect(capped.projections.length).toBeLessThanOrEqual(uncapped.projections.length);
  expect(capped.projections.length).toBeLessThanOrEqual(3);
  expect(capped.targetMet).toBe(true);
  // The appeals directory collapsed into one review unit; inbox is untouched
  // by it, and docs/manifests stay out of directory merging entirely.
  expect(projectionFor(capped, "src/appeals/format.ts").files).toContain("src/appeals/report.ts");
  expect(projectionFor(capped, "README.md").files).toEqual(["README.md"]);
});

test("coarsening is deterministic across replans", async () => {
  const a = computeProjections(await plan(), { targetSlices: 3 });
  const b = computeProjections(await plan(), { targetSlices: 3 });
  expect(b.projections.map((p) => p.signature)).toEqual(a.projections.map((p) => p.signature));
  expect(b.projections.map((p) => p.files)).toEqual(a.projections.map((p) => p.files));
});

test("the projection graph stays acyclic and every prerequisite is a real projection", async () => {
  const coarse = computeProjections(await plan(), { targetSlices: 2 });
  const labels = new Set(coarse.projections.map((p) => p.label));
  for (const proj of coarse.projections) {
    for (const req of proj.prerequisites) {
      expect(labels.has(req)).toBe(true);
      expect(req).not.toBe(proj.label);
      // Prerequisites come earlier in the emitted topological order.
      expect(coarse.order.indexOf(req)).toBeLessThan(coarse.order.indexOf(proj.label));
    }
  }
});

test("the coarsened projection still reconstructs the mega-branch tree", async () => {
  const p = await plan();
  using _db = openStore(repoRoot);
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);

  for (const target of [undefined, 3, 2]) {
    const coarse = computeProjections(p, { targetSlices: target });
    const units = projectedUnits(p, coarse);
    const result = await verifyTreeHash({
      git: backend,
      repoRoot,
      branch: "feature",
      mergeBase,
      files: p.files,
      order: units.order,
      slices: units.slices,
    });
    expect(result.pass).toBe(true);
  }
});
