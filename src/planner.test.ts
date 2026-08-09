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

  const symbolSlices = [...plan.slices.keys()].filter((id) => !plan.fallbackGroups.has(id));
  expect(symbolSlices.length).toBe(3);

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

test("issue #4: two unrelated changed constructors don't create a false cycle via the shared leaf name 'constructor'", async () => {
  const { repoRoot: ctorRoot, cleanup } = makeTempRepo("drip-planner-test-ctor-");
  try {
    writeFileSync(join(ctorRoot, "service.ts"), `export class Service {\n  constructor() {}\n}\n`);
    writeFileSync(join(ctorRoot, "controller.ts"), `import { Service } from "./service";\n\nexport class Controller {\n  x = 1;\n}\n`);
    commit(ctorRoot, "init");

    git(["checkout", "-q", "-b", "feature"], ctorRoot);
    // Both constructors change in the same diff. Controller's constructor
    // references Service (meaningful edge). Service's constructor body does
    // not mention "Controller" (no reverse edge should be inferred).
    writeFileSync(join(ctorRoot, "service.ts"), `export class Service {\n  constructor() {\n    console.log("ready");\n  }\n}\n`);
    writeFileSync(
      join(ctorRoot, "controller.ts"),
      `import { Service } from "./service";\n\nexport class Controller {\n  constructor(private readonly service: Service) {}\n}\n`,
    );
    commit(ctorRoot, "constructors changed");

    const plan = await computePlan({ git: backend, repoRoot: ctorRoot, branch: "feature", baseBranch: "main" });
    expect(plan.order).not.toBeNull(); // no false cycle

    const controllerSlice = sliceContaining(plan, "controller.ts");
    const serviceSlice = sliceContaining(plan, "service.ts");
    expect(controllerSlice).not.toBe(serviceSlice);
    // Meaningful edge retained: Controller depends on Service.
    expect(plan.edges).toContainEqual([controllerSlice, serviceSlice]);
    // No spurious reverse edge from Service to Controller via "constructor".
    expect(plan.edges).not.toContainEqual([serviceSlice, controllerSlice]);
  } finally {
    cleanup();
  }
});

test("issue #5: same-named unexported local helpers in different files don't create a cross-file edge", async () => {
  const { repoRoot: localRoot, cleanup } = makeTempRepo("drip-planner-test-local-helper-");
  try {
    writeFileSync(join(localRoot, "one.test.ts"), `function renderSection() {\n  return "a";\n}\nrenderSection();\n`);
    writeFileSync(join(localRoot, "two.test.ts"), `function renderSection() {\n  return "b";\n}\nrenderSection();\n`);
    commit(localRoot, "init");

    git(["checkout", "-q", "-b", "feature"], localRoot);
    writeFileSync(join(localRoot, "one.test.ts"), `function renderSection() {\n  return "a2";\n}\nrenderSection();\n`);
    writeFileSync(join(localRoot, "two.test.ts"), `function renderSection() {\n  return "b2";\n}\nrenderSection();\n`);
    commit(localRoot, "both helpers changed");

    const plan = await computePlan({ git: backend, repoRoot: localRoot, branch: "feature", baseBranch: "main" });
    expect(plan.order).not.toBeNull(); // no false cycle

    const oneSlice = sliceContaining(plan, "one.test.ts");
    const twoSlice = sliceContaining(plan, "two.test.ts");
    expect(plan.edges).not.toContainEqual([oneSlice, twoSlice]);
    expect(plan.edges).not.toContainEqual([twoSlice, oneSlice]);
  } finally {
    cleanup();
  }
});

test("issue #7: non-symbol hunks form per-file fallback groups, not one global ungrouped bucket", async () => {
  const { repoRoot: fbRoot, cleanup } = makeTempRepo("drip-planner-test-fallback-");
  try {
    writeFileSync(join(fbRoot, "package.json"), `{\n  "name": "x",\n  "version": "1.0.0"\n}\n`);
    writeFileSync(join(fbRoot, "bun.lock"), `lockfileVersion: 1\ndeps: []\n`);
    writeFileSync(join(fbRoot, "README.md"), `# x\n\nsome docs\n`);
    writeFileSync(join(fbRoot, ".gitignore"), `node_modules\n`);
    writeFileSync(
      join(fbRoot, "app.ts"),
      // The import sits far enough from the function that git emits two
      // separate hunks — one top-level, one inside the symbol.
      `import { readFile } from "node:fs";\n\nconst PAD1 = 1;\nconst PAD2 = 2;\nconst PAD3 = 3;\nconst PAD4 = 4;\nconst PAD5 = 5;\nconst PAD6 = 6;\n\nexport function load() {\n  return readFile;\n}\n`,
    );
    commit(fbRoot, "init");

    git(["checkout", "-q", "-b", "feature"], fbRoot);
    writeFileSync(join(fbRoot, "package.json"), `{\n  "name": "x",\n  "version": "1.1.0"\n}\n`);
    writeFileSync(join(fbRoot, "bun.lock"), `lockfileVersion: 1\ndeps: ["a"]\n`);
    writeFileSync(join(fbRoot, "README.md"), `# x\n\nsome other docs\n`);
    writeFileSync(join(fbRoot, ".gitignore"), `node_modules\ndist\n`);
    writeFileSync(
      join(fbRoot, "app.ts"),
      `import { writeFile } from "node:fs";\n\nconst PAD1 = 1;\nconst PAD2 = 2;\nconst PAD3 = 3;\nconst PAD4 = 4;\nconst PAD5 = 5;\nconst PAD6 = 6;\n\nexport function load() {\n  return writeFile;\n}\n`,
    );
    commit(fbRoot, "unrelated non-symbol changes");

    const plan = await computePlan({ git: backend, repoRoot: fbRoot, branch: "feature", baseBranch: "main" });
    expect(plan.order).not.toBeNull();

    const groups = [...plan.fallbackGroups.values()];
    const filesOf = (selector: string) => groups.find((g) => g.selectors.includes(selector))?.files;

    // The core of the issue: unrelated fallback material is not one slice.
    expect(groups.length).toBe(4);

    // Manifest + lockfile share a group; nothing else joins them.
    expect(filesOf("package.json::(deps)")).toEqual(["bun.lock", "package.json"]);
    // Docs, gitignore and the top-level import hunk are each their own group.
    expect(filesOf("README.md::(file)")).toEqual(["README.md"]);
    expect(filesOf(".gitignore::(file)")).toEqual([".gitignore"]);
    expect(filesOf("app.ts::(file)")).toEqual(["app.ts"]);

    const reasonFor = (selector: string) => groups.find((g) => g.selectors.includes(selector))?.reasons;
    expect(reasonFor("package.json::(deps)")).toEqual(["dependency-manifest"]);
    expect(reasonFor("README.md::(file)")).toEqual(["unsupported-language"]);
    expect(reasonFor("app.ts::(file)")).toEqual(["no-enclosing-symbol"]);

    // Fallback identity is derived from the path alone, so it survives a replan.
    const replanned = await computePlan({ git: backend, repoRoot: fbRoot, branch: "feature", baseBranch: "main" });
    expect([...replanned.fallbackGroups.values()].map((g) => g.selectors).sort()).toEqual(groups.map((g) => g.selectors).sort());
  } finally {
    cleanup();
  }
});

test("issue #7: a fallback group can be force_merged into the symbol slice it belongs with", async () => {
  const { repoRoot: mergeRoot, cleanup } = makeTempRepo("drip-planner-test-fallback-override-");
  try {
    writeFileSync(join(mergeRoot, "README.md"), `# x\n`);
    writeFileSync(join(mergeRoot, "app.ts"), `export function load() {\n  return 1;\n}\n`);
    commit(mergeRoot, "init");

    git(["checkout", "-q", "-b", "feature"], mergeRoot);
    writeFileSync(join(mergeRoot, "README.md"), `# x\n\ndocumented\n`);
    writeFileSync(join(mergeRoot, "app.ts"), `export function load() {\n  return 2;\n}\n`);
    commit(mergeRoot, "docs + code");

    const plan = await computePlan({
      git: backend,
      repoRoot: mergeRoot,
      branch: "feature",
      baseBranch: "main",
      overrides: [{ kind: "force_merge", selectorA: "README.md::(file)", selectorB: "app.ts::load", note: null }],
    });
    expect(plan.ignoredOverrides).toEqual([]);
    expect(sliceContaining(plan, "README.md")).toBe(sliceContaining(plan, "app.ts"));
    // Merged into a symbol slice, it is no longer reported as a fallback group.
    expect(plan.fallbackGroups.size).toBe(0);
  } finally {
    cleanup();
  }
});

test("issue #5: a changed exported helper still produces a real cross-file dependency edge", async () => {
  const { repoRoot: expRoot, cleanup } = makeTempRepo("drip-planner-test-exported-helper-");
  try {
    writeFileSync(join(expRoot, "helper.ts"), `export function renderSection() {\n  return "a";\n}\n`);
    writeFileSync(join(expRoot, "page.ts"), `import { renderSection } from "./helper";\n\nexport function page() {\n  return renderSection();\n}\n`);
    commit(expRoot, "init");

    git(["checkout", "-q", "-b", "feature"], expRoot);
    writeFileSync(join(expRoot, "helper.ts"), `export function renderSection() {\n  return "a2";\n}\n`);
    writeFileSync(
      join(expRoot, "page.ts"),
      `import { renderSection } from "./helper";\n\nexport function page() {\n  return renderSection() + "!";\n}\n`,
    );
    commit(expRoot, "both changed");

    const plan = await computePlan({ git: backend, repoRoot: expRoot, branch: "feature", baseBranch: "main" });
    expect(plan.order).not.toBeNull();

    const helperSlice = sliceContaining(plan, "helper.ts");
    const pageSlice = sliceContaining(plan, "page.ts");
    expect(plan.edges).toContainEqual([pageSlice, helperSlice]);
  } finally {
    cleanup();
  }
});
