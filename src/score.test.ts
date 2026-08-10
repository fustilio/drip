import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjections } from "./coarsen";
import { ShellGitBackend } from "./git-backend";
import { computePlan, groupKeyOf, type PlanResult } from "./planner";
import { DEFAULT_THRESHOLD, ExpectedPartitionSchema, loadExpectedPartition, scoreBoundaries, type ExpectedPartition } from "./score";
import { commit, git, makeTempRepo } from "./test-helpers";

// Scored against a real plan from a real repo, like every other suite here
// (docs/adr/0010): what's being measured is the planner's actual output, so a
// hand-built PlanResult would be measuring the fixture instead.
//
// The fixture is shaped so drip's partition is knowable: a shared helper with
// two consumers (an ordering edge, not a merge), a second auth symbol far
// enough away to be its own hunk, and a markdown file that can only be a
// fallback group.
const backend = new ShellGitBackend();
let repoRoot: string;
let cleanupRepo: () => void;

const FILLER = Array.from({ length: 8 }, (_, i) => `const A${i} = ${i};`).join("\n");

beforeAll(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-score-test-"));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  const write = (p: string, s: string) => writeFileSync(join(repoRoot, p), s);

  write("README.md", `# fixture\n`);
  write("src/util.ts", `export function format(s: string) {\n  return s;\n}\n`);
  write(
    "src/auth.ts",
    `import { format } from "./util";\n\nexport function login(u: string) {\n  return format(u);\n}\n\n${FILLER}\n\nexport function logout() {\n  return true;\n}\n`,
  );
  write("src/report.ts", `import { format } from "./util";\n\nexport function renderReport() {\n  return format("report");\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  write("README.md", `# fixture\n\nnotes\n`);
  write("src/util.ts", `export function format(s: string) {\n  return s.trim();\n}\n`);
  write(
    "src/auth.ts",
    `import { format } from "./util";\n\nexport function login(u: string) {\n  return format(u.toLowerCase());\n}\n\n${FILLER}\n\nexport function logout() {\n  return false;\n}\n`,
  );
  write("src/report.ts", `import { format } from "./util";\n\nexport function renderReport() {\n  return format("REPORT");\n}\n`);
  commit(repoRoot, "feature");
});

afterAll(() => cleanupRepo());

const plan = async (): Promise<PlanResult> => computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });

// drip's atomic partition in the shape the scorer consumes — the same mapping
// the CLI does, kept here so the tests read against slice labels.
const atomicUnits = (p: PlanResult) => ({
  order: p.order!.map((id) => `slice${p.idToNum.get(id)}`),
  slices: new Map(p.order!.map((id) => [`slice${p.idToNum.get(id)}`, p.slices.get(id)!])),
});

const partition = (units: ExpectedPartition["units"], label?: string): ExpectedPartition =>
  ExpectedPartitionSchema.parse({ version: 1, ...(label ? { label } : {}), units });

const LOGIN = "src/auth.ts::login";
const LOGOUT = "src/auth.ts::logout";
const FORMAT = "src/util.ts::format";
const REPORT = "src/report.ts::renderReport";
const DOCS = "README.md::(file)";

test("a hand-drawn partition matching drip exactly scores 1.0", async () => {
  const result = scoreBoundaries({
    units: atomicUnits(await plan()),
    expected: partition([
      { id: "login", selectors: [LOGIN] },
      { id: "logout", selectors: [LOGOUT] },
      { id: "shared", selectors: [FORMAT] },
      { id: "report", selectors: [REPORT] },
    ]),
    layer: "atomic",
  });
  expect(result.agreement).toBe(1);
  expect(result.pass).toBe(true);
  expect(result.disagreements).toEqual([]);
  expect(result.units.every((u) => u.spread.length === 1 && u.sharedWith.length === 0)).toBe(true);
});

test("a hand-drawn unit drip split apart is reported as a split, and costs the fragments", async () => {
  // A reviewer would take both auth changes together; drip's symbol clustering
  // keeps them apart, because nothing in the code connects them.
  const result = scoreBoundaries({
    units: atomicUnits(await plan()),
    expected: partition([
      { id: "auth", selectors: [LOGIN, LOGOUT] },
      { id: "rest", selectors: [FORMAT, REPORT] },
    ]),
    layer: "atomic",
  });
  const auth = result.units.find((u) => u.id === "auth")!;
  expect(auth.hunks).toBe(2);
  expect(auth.spread.length).toBe(2);
  expect(auth.agreed).toBe(1); // the fragment that kept the match
  // Half the hunks landed somewhere their hand-drawn unit didn't, and each is
  // named by selector rather than summed away.
  expect(result.agreement).toBe(0.5);
  expect(result.disagreements.map((d) => d.selector).sort()).toEqual([LOGIN, REPORT].sort());
});

test("two hand-drawn units drip merged are reported as a merge, not scored as two successes", async () => {
  const p = await plan();
  // Coarsening to a two-projection budget puts every source slice together —
  // the merge case at the layer where merges actually happen.
  const coarse = computeProjections(p, { targetSlices: 2 });
  const units = {
    order: coarse.order,
    slices: new Map(coarse.projections.map((x) => [x.label, x.sliceIds.flatMap((s) => p.slices.get(s)!)])),
  };
  const result = scoreBoundaries({
    units,
    expected: partition([
      { id: "login-work", selectors: [LOGIN] },
      { id: "report-work", selectors: [REPORT] },
    ]),
    layer: "candidates",
  });
  // A plurality mapping would call this two perfect units. The injective match
  // gives the projection to one and scores the other as a disagreement.
  expect(result.agreement).toBe(0.5);
  const winner = result.units.find((u) => u.matched !== null)!;
  expect(winner.sharedWith.length).toBe(1);
  expect(result.units.find((u) => u.matched === null)!.hunks).toBe(1);
});

test("fallback-group hunks are excluded from the score by default and countable on request", async () => {
  const p = await plan();
  const expected = partition([
    { id: "docs", selectors: [DOCS] },
    { id: "login", selectors: [LOGIN] },
  ]);

  const withoutFallback = scoreBoundaries({ units: atomicUnits(p), expected, layer: "atomic" });
  expect(withoutFallback.excludedFallbackHunks).toBe(1);
  // Named but not scored: a selector that exists in the plan is never reported
  // as one the plan doesn't have.
  expect(withoutFallback.unmatchedSelectors).toEqual([]);
  expect(withoutFallback.units.find((u) => u.id === "docs")!.hunks).toBe(0);

  const withFallback = scoreBoundaries({ units: atomicUnits(p), expected, layer: "atomic", includeFallback: true });
  expect(withFallback.excludedFallbackHunks).toBe(0);
  expect(withFallback.units.find((u) => u.id === "docs")!.hunks).toBe(1);
  expect(withFallback.scoredHunks).toBe(withoutFallback.scoredHunks + 1);
});

test("selectors that no longer exist are reported, never silently dropped", async () => {
  const result = scoreBoundaries({
    units: atomicUnits(await plan()),
    expected: partition([
      { id: "login", selectors: [LOGIN, "src/auth.ts::renamedAway"] },
      { id: "gone", selectors: ["src/deleted.ts::vanished"] },
    ]),
    layer: "atomic",
  });
  expect(result.unmatchedSelectors).toEqual(["src/auth.ts::renamedAway", "src/deleted.ts::vanished"]);
  // A unit whose every selector vanished scores nothing, rather than counting
  // as agreement with a slice it never described.
  expect(result.units.find((u) => u.id === "gone")!.hunks).toBe(0);
});

test("a partition that matches nothing in this plan fails rather than scoring 0/0 as a pass", async () => {
  const result = scoreBoundaries({
    units: atomicUnits(await plan()),
    expected: partition([{ id: "elsewhere", selectors: ["src/other.ts::somethingElse"] }]),
    layer: "atomic",
  });
  expect(result.scoredHunks).toBe(0);
  expect(result.agreement).toBe(0);
  expect(result.pass).toBe(false);
});

test("the same plan and partition score identically twice, including the matching", async () => {
  const expected = partition([
    { id: "auth", selectors: [LOGIN, LOGOUT] },
    { id: "rest", selectors: [FORMAT, REPORT] },
  ]);
  const a = scoreBoundaries({ units: atomicUnits(await plan()), expected, layer: "atomic" });
  const b = scoreBoundaries({ units: atomicUnits(await plan()), expected, layer: "atomic" });
  expect(b.agreement).toBe(a.agreement);
  expect(b.units.map((u) => `${u.id}->${u.matched}`)).toEqual(a.units.map((u) => `${u.id}->${u.matched}`));
  expect(b.disagreements).toEqual(a.disagreements);
});

test("the gate is BUILD-PLAN's two-thirds, and the threshold is what decides pass/fail", async () => {
  const p = await plan();
  expect(DEFAULT_THRESHOLD).toBeCloseTo(2 / 3, 10);
  const half = partition([
    { id: "auth", selectors: [LOGIN, LOGOUT] },
    { id: "rest", selectors: [FORMAT, REPORT] },
  ]);
  // 50% agreement: below the default gate, above a lenient one. Nothing about
  // the measurement changes — only the line drawn through it.
  expect(scoreBoundaries({ units: atomicUnits(p), expected: half, layer: "atomic" }).pass).toBe(false);
  expect(scoreBoundaries({ units: atomicUnits(p), expected: half, layer: "atomic", threshold: 0.4 }).pass).toBe(true);
});

test("the candidate layer is scored through the same instrument as the atomic one", async () => {
  const p = await plan();
  const coarse = computeProjections(p, { targetSlices: 2 });
  const units = {
    order: coarse.order,
    slices: new Map(coarse.projections.map((x) => [x.label, x.sliceIds.flatMap((s) => p.slices.get(s)!)])),
  };
  // Review units drawn to match the coarsened candidates exactly: the layer
  // above the atomic slices is scoreable with no second implementation.
  const expected = partition(
    coarse.projections
      .map((x) => ({
        id: x.label,
        selectors: [...new Set(x.sliceIds.flatMap((s) => p.slices.get(s)!.map(groupKeyOf)))],
      }))
      .filter((u) => u.selectors.some((s) => !s.endsWith("::(file)"))),
  );
  const result = scoreBoundaries({ units, expected, layer: "candidates" });
  expect(result.layer).toBe("candidates");
  expect(result.agreement).toBe(1);
  expect(result.scoredHunks).toBe(scoreBoundaries({ units: atomicUnits(p), expected, layer: "atomic" }).scoredHunks);
});

test("a selector claimed by two hand-drawn units is reported, and the first claim wins", async () => {
  const result = scoreBoundaries({
    units: atomicUnits(await plan()),
    expected: partition([
      { id: "first", selectors: [LOGIN] },
      { id: "second", selectors: [LOGIN, LOGOUT] },
    ]),
    layer: "atomic",
  });
  expect(result.duplicateSelectors).toEqual([LOGIN]);
  expect(result.units.find((u) => u.id === "first")!.hunks).toBe(1);
  expect(result.units.find((u) => u.id === "second")!.hunks).toBe(1);
});

test("a malformed or ambiguous partition file is refused with the reason", () => {
  const path = join(repoRoot, "expected.json");
  writeFileSync(path, "{ not json");
  expect(() => loadExpectedPartition(path)).toThrow(/not valid JSON/);

  writeFileSync(path, JSON.stringify({ version: 2, units: [] }));
  expect(() => loadExpectedPartition(path)).toThrow(/v1 hand-drawn partition schema/);

  writeFileSync(path, JSON.stringify({ version: 1, units: [{ id: "a", selectors: ["x::y"] }, { id: "a", selectors: ["p::q"] }] }));
  expect(() => loadExpectedPartition(path)).toThrow(/two units with id 'a'/);

  writeFileSync(path, JSON.stringify({ version: 1, label: "exercise", units: [{ id: "a", selectors: ["x::y"] }] }));
  expect(loadExpectedPartition(path).label).toBe("exercise");
});
