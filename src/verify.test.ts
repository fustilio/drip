import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { computePlan } from "./planner";
import { openStore } from "./store";
import { commit, git, makeTempRepo } from "./test-helpers";
import { verifyPerSliceBuild } from "./verify";

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanup: () => void;

// Two files, two independent slices (no shared symbol, no edge) — the
// simplest fixture that can show the prefix-skip is real: order matters.
beforeEach(() => {
  ({ repoRoot, cleanup } = makeTempRepo("drip-verify-test-"));
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 1;\n}\n`);
  writeFileSync(join(repoRoot, "b.ts"), `export function b() {\n  return 1;\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "a.ts"), `export function a() {\n  return 2;\n}\n`);
  writeFileSync(join(repoRoot, "b.ts"), `export function b() {\n  return 2;\n}\n`);
  commit(repoRoot, "feature");
});

afterEach(() => cleanup());

test("build-cache prefix-skip: unchanged stack reuses everything, an edit rebuilds only itself and what follows it", async () => {
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  expect(plan.order).not.toBeNull();
  expect(plan.order!.length).toBe(2);

  using db = openStore(repoRoot);
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const runOpts = { git: backend, db, branch: "feature", repoRoot, mergeBase, files: plan.files, order: plan.order!, slices: plan.slices, idToNum: plan.idToNum, buildCmd: "bun -e \"process.exit(0)\"" };

  const first = await verifyPerSliceBuild(runOpts);
  expect(first.failures).toEqual([]);
  expect(first.skipped).toBe(0); // nothing cached yet — both slices build

  const second = await verifyPerSliceBuild(runOpts);
  expect(second.failures).toEqual([]);
  expect(second.skipped).toBe(2); // identical content — both reused from cache

  // Edit only the slice last in topological order (no edges, so order is
  // whatever computePlan produced — find it and change that file).
  const lastSliceId = plan.order![plan.order!.length - 1]!;
  const lastFile = plan.slices.get(lastSliceId)![0]!.file;
  writeFileSync(join(repoRoot, lastFile), `export function ${lastFile.replace(".ts", "")}() {\n  return 3;\n}\n`);
  commit(repoRoot, "edit last slice");

  const replan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const remergeBase = backend.mergeBase("main", "feature", repoRoot);
  const third = await verifyPerSliceBuild({ ...runOpts, mergeBase: remergeBase, files: replan.files, order: replan.order!, slices: replan.slices, idToNum: replan.idToNum });
  expect(third.failures).toEqual([]);
  expect(third.skipped).toBe(1); // the untouched first-in-order slice is still cached; the edited one rebuilds
});
