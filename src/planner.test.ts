import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { computePlan } from "./planner";

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function commit(cwd: string, message: string) {
  git(["add", "-A"], cwd);
  git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", message], cwd);
}

const backend = new ShellGitBackend();
let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "drip-planner-test-"));
  git(["init", "-q"], repoRoot);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], repoRoot);
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
  rmSync(repoRoot, { recursive: true, force: true });
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
  const cycleRoot = mkdtempSync(join(tmpdir(), "drip-planner-test-cycle-"));
  try {
    git(["init", "-q"], cycleRoot);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], cycleRoot);
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
  } finally {
    rmSync(cycleRoot, { recursive: true, force: true });
  }
});
