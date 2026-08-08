import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { computeCycleDiagnostics, computePlan, planToJson } from "./planner";
import { commit, git, makeTempRepo } from "./test-helpers";

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanupRepo: () => void;

beforeAll(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-planner-test-"));
  mkdirSync(join(repoRoot, "src"), { recursive: true });

  writeFileSync(join(repoRoot, "src", "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "src", "helper.ts"), `export function shared(x: number) {\n  return x + 2;\n}\n`);
  writeFileSync(join(repoRoot, "src", "a.ts"), `import { shared } from "./helper";\n\nexport function featureA() {\n  return shared(1);\n}\n`);
  writeFileSync(join(repoRoot, "src", "b.ts"), `import { shared } from "./helper";\n\nexport function featureB() {\n  return shared(2);\n}\n`);
  commit(repoRoot, "feature");
});

afterAll(() => {
  cleanupRepo();
});

function sliceContaining(plan: Awaited<ReturnType<typeof computePlan>>, file: string): string {
  const entry = [...plan.slices.entries()].find(([, hunks]) => hunks.some((h) => h.file === file));
  if (!entry) throw new Error(`no slice contains ${file}`);
  return entry[0];
}

test("shared helper falls out as its own slice; both callers depend on it independently, not merged", async () => {
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  expect(plan.order).not.toBeNull();

  const nonUngrouped = [...plan.slices.keys()].filter((id) => id !== plan.ungroupedId);
  expect(nonUngrouped.length).toBe(3);

  const helperSlice = sliceContaining(plan, "src/helper.ts");
  const aSlice = sliceContaining(plan, "src/a.ts");
  const bSlice = sliceContaining(plan, "src/b.ts");

  expect(aSlice).not.toBe(helperSlice);
  expect(bSlice).not.toBe(helperSlice);
  expect(aSlice).not.toBe(bSlice);

  expect(plan.edges).toContainEqual([aSlice, helperSlice]);
  expect(plan.edges).toContainEqual([bSlice, helperSlice]);
});

test("force_merge override combines two otherwise-independent slices", async () => {
  const plan = await computePlan({
    git: backend,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    overrides: [{ kind: "force_merge", selectorA: "src/a.ts::featureA", selectorB: "src/b.ts::featureB", note: null }],
  });
  expect(sliceContaining(plan, "src/a.ts")).toBe(sliceContaining(plan, "src/b.ts"));
});

test("unmatched override selector is reported in ignoredOverrides, not silently dropped", async () => {
  const plan = await computePlan({
    git: backend,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    overrides: [{ kind: "force_merge", selectorA: "src/a.ts::featureA", selectorB: "src/nope.ts::nothing", note: null }],
  });
  expect(plan.ignoredOverrides).toContain("src/nope.ts::nothing");
});

test("mutually-recursive cross-file def-use forms a cycle — reported as unresolvable, not silently mis-ordered", async () => {
  const { repoRoot: cycleRoot, cleanup } = makeTempRepo("drip-planner-test-cycle-");
  try {
    writeFileSync(join(cycleRoot, "README.md"), "cycle fixture\n");
    commit(cycleRoot, "init");

    git(["checkout", "-q", "-b", "feature"], cycleRoot);
    writeFileSync(
      join(cycleRoot, "x.ts"),
      `import { isOdd } from "./y";\n\nexport function isEven(n: number): boolean {\n  if (n === 0) return true;\n  return isOdd(n - 1);\n}\n`,
    );
    writeFileSync(
      join(cycleRoot, "y.ts"),
      `import { isEven } from "./x";\n\nexport function isOdd(n: number): boolean {\n  if (n === 0) return false;\n  return isEven(n - 1);\n}\n`,
    );
    commit(cycleRoot, "cycle");

    const plan = await computePlan({ git: backend, repoRoot: cycleRoot, branch: "feature", baseBranch: "main" });
    expect(plan.order).toBeNull();

    // Issue #3: a null order must not swallow the diagnostics needed to act on it.
    const cycles = computeCycleDiagnostics(plan);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.slices).toHaveLength(2);
    expect(cycles[0]!.edges).toHaveLength(2); // isEven->isOdd and isOdd->isEven
    for (const e of cycles[0]!.edges) {
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.evidence[0]!.symbol === "isEven" || e.evidence[0]!.symbol === "isOdd").toBe(true);
    }
    expect(cycles[0]!.overridesTouching).toEqual([]); // no overrides configured in this fixture

    const json = planToJson(plan) as { ok: boolean; slices: unknown[]; cycles: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.slices).toHaveLength(2); // inferred slices are surfaced even on failure
    expect(json.cycles).toHaveLength(1);
  } finally {
    cleanup();
  }
});
