import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellGitBackend } from "./git-backend";
import { ManifestSchema, manifestSignature, resolveManifest, type Manifest } from "./manifest";
import { materializeProjections } from "./materialize-local";
import { computePlan } from "./planner";
import { openStore, upsertCorrespondence } from "./store";
import { commit, git, gitOutput, makeBareRemote, makeTempRepo } from "./test-helpers";

// materialize is the one command that produces a projection's commits without
// going anywhere near GitHub (issue #13), so every test here also asserts the
// negative: nothing on the remote, nothing through `gh`.
const gh = {
  ghCreatePr: mock((_opts: unknown) => ({ number: 42, url: "https://example.com/pull/42" })),
  ghPrClose: mock(() => {}),
  ghPrComment: mock(() => {}),
  ghPrSetBase: mock(() => {}),
  ghPrState: mock(() => "OPEN"),
};
mock.module("./github", () => gh);

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanupRepo: () => void;
let remoteRoot: string;
let cleanupRemote: () => void;
let outputRoot: string;

const NO_CHECKS = "fixture: covered by the suite that owns this file";

// Three projections: `formatter` is a root, `report` depends on it (a real
// atomic edge — renderReport calls formatAppeal), `docs` is independent.
const manifest = (): Manifest =>
  ManifestSchema.parse({
    version: 1,
    sourceBranch: "feature",
    projections: [
      { id: "formatter", atomicSlices: ["src/appeals/format.ts::formatAppeal"], verificationReason: NO_CHECKS },
      { id: "report", atomicSlices: ["src/appeals/report.ts::renderReport"], dependsOn: ["formatter"], verificationReason: NO_CHECKS },
      { id: "docs", atomicSlices: ["README.md::(file)"], verificationReason: NO_CHECKS },
    ],
  });

beforeEach(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-materialize-test-"));
  ({ remoteRoot, cleanup: cleanupRemote } = makeBareRemote("drip-materialize-remote-"));
  git(["remote", "add", "origin", remoteRoot], repoRoot);
  outputRoot = mkdtempSync(join(tmpdir(), "drip-materialize-out-"));

  mkdirSync(join(repoRoot, "src", "appeals"), { recursive: true });
  const write = (p: string, s: string) => writeFileSync(join(repoRoot, p), s);
  write("README.md", `# fixture\n`);
  write("src/appeals/format.ts", `export function formatAppeal(x: string) {\n  return x;\n}\n`);
  write(
    "src/appeals/report.ts",
    `import { formatAppeal } from "./format";\n\nexport function renderReport(x: string) {\n  return formatAppeal(x);\n}\n`,
  );
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  write("README.md", `# fixture\n\ndocumented\n`);
  write("src/appeals/format.ts", `export function formatAppeal(x: string) {\n  return x.trim();\n}\n`);
  write(
    "src/appeals/report.ts",
    `import { formatAppeal, type Appeal } from "./format";\n\nexport function renderReport(x: string) {\n  return formatAppeal(x).toUpperCase();\n}\n`,
  );
  commit(repoRoot, "feature");

  for (const m of Object.values(gh)) m.mockClear();
});

afterEach(() => {
  cleanupRepo();
  cleanupRemote();
  rmSync(outputRoot, { recursive: true, force: true });
});

async function run(opts: { mode?: "flat-first" | "stacked"; only?: string[]; outputDir?: string | null; force?: boolean } = {}) {
  const db = openStore(repoRoot);
  const plan = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  const mergeBase = backend.mergeBase("main", "feature", repoRoot);
  const resolved = resolveManifest(plan, manifest(), { branch: "feature" });
  expect(resolved.ok).toBe(true);
  const result = await materializeProjections({
    git: backend,
    db,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    mergeBase,
    plan,
    resolved,
    mode: opts.mode ?? "flat-first",
    only: opts.only,
    outputDir: opts.outputDir ?? null,
    force: opts.force,
  });
  const byId = new Map(result.projections.map((p) => [p.projectionId, p]));
  return { result, byId, db, plan, mergeBase };
}

const localRefs = () =>
  gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/drip"], repoRoot)
    .split("\n")
    .filter(Boolean);

const remoteRefs = () => gitOutput(["for-each-ref", "--format=%(refname:short)"], remoteRoot).split("\n").filter(Boolean);

const fileAt = (ref: string, path: string) => gitOutput(["show", `${ref}:${path}`], repoRoot);

test("flat-first: one local ref per projection, bases taken from the manifest graph", async () => {
  const { result, byId } = await run();
  expect(result.ok).toBe(true);
  expect(result.projections.map((p) => p.status)).toEqual(["created", "created", "created"]);
  expect(localRefs().sort()).toEqual(["drip/feature/docs", "drip/feature/formatter", "drip/feature/report"]);

  // Independent projections target the base branch; a dependent targets its
  // prerequisite's ref, not whatever came before it in topological order.
  expect(byId.get("formatter")!.base).toBe("main");
  expect(byId.get("docs")!.base).toBe("main");
  expect(byId.get("report")!.base).toBe("drip/feature/formatter");
  expect(byId.get("report")!.prerequisites).toEqual(["formatter"]);

  // The refs hold the projection's content and only its content.
  expect(fileAt("drip/feature/formatter", "src/appeals/format.ts")).toContain("x.trim()");
  expect(fileAt("drip/feature/docs", "src/appeals/format.ts")).toContain("return x;"); // untouched by an independent projection
  expect(fileAt("drip/feature/report", "src/appeals/format.ts")).toContain("x.trim()"); // prerequisite closure is present
});

test("no remote ref is written and no GitHub call is made", async () => {
  await run({ outputDir: outputRoot });
  expect(remoteRefs()).toEqual([]);
  for (const [name, m] of Object.entries(gh)) expect([name, m.mock.calls.length]).toEqual([name, 0]);
});

test("re-running is a no-op: same trees, same shas, nothing rewritten", async () => {
  const first = await run();
  const shas = localRefs().map((r) => gitOutput(["rev-parse", r], repoRoot).trim());

  const second = await run();
  expect(second.result.projections.map((p) => p.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
  // `commit-tree` mints a fresh sha every run, so sameness is judged by tree —
  // otherwise every re-run would look like a rewrite and demand --force.
  expect(localRefs().map((r) => gitOutput(["rev-parse", r], repoRoot).trim())).toEqual(shas);
  expect(first.result.ok && second.result.ok).toBe(true);
});

test("a ref that exists with different content is blocked until --force", async () => {
  await run();
  const before = gitOutput(["rev-parse", "drip/feature/formatter"], repoRoot).trim();

  writeFileSync(join(repoRoot, "src/appeals/format.ts"), `export function formatAppeal(x: string) {\n  return x.trimEnd();\n}\n`);
  commit(repoRoot, "reworked the formatter");

  const blocked = await run();
  expect(blocked.byId.get("formatter")!.status).toBe("blocked");
  expect(blocked.byId.get("formatter")!.note).toContain("--force");
  expect(blocked.result.ok).toBe(false);
  expect(gitOutput(["rev-parse", "drip/feature/formatter"], repoRoot).trim()).toBe(before); // left alone

  const forced = await run({ force: true });
  expect(forced.byId.get("formatter")!.status).toBe("updated");
  expect(fileAt("drip/feature/formatter", "src/appeals/format.ts")).toContain("x.trimEnd()");
});

test("--only writes the selection and its prerequisite closure, and nothing else", async () => {
  const { result, byId } = await run({ only: ["report"] });
  expect(localRefs().sort()).toEqual(["drip/feature/formatter", "drip/feature/report"]);
  expect(byId.get("report")!.selected).toBe(true);
  // The prerequisite is materialized because the selection is built on it, and
  // is reported as such rather than silently appearing as a chosen projection.
  expect(byId.get("formatter")!.selected).toBe(false);
  expect(result.projections.some((p) => p.projectionId === "docs")).toBe(false);
});

test("--only on an unknown projection id fails loudly", async () => {
  await expect(run({ only: ["nope"] })).rejects.toThrow(/no projection 'nope'/);
});

test("--output checks each materialized projection out into its own worktree", async () => {
  const { byId } = await run({ outputDir: outputRoot });
  for (const id of ["formatter", "report", "docs"]) {
    expect(byId.get(id)!.worktree).toBe(join(outputRoot, id));
    expect(existsSync(join(outputRoot, id, "src", "appeals", "format.ts"))).toBe(true);
  }
  // Each worktree holds that projection's own tree, not the mega branch's.
  expect(gitOutput(["show", "HEAD:src/appeals/report.ts"], join(outputRoot, "formatter"))).toContain("formatAppeal(x);");
  expect(gitOutput(["show", "HEAD:src/appeals/report.ts"], join(outputRoot, "report"))).toContain("toUpperCase()");
});

test("an existing worktree path is reported, not silently replaced", async () => {
  await run({ outputDir: outputRoot });
  const { byId } = await run({ outputDir: outputRoot });
  expect(byId.get("docs")!.worktree).toBeNull();
  expect(byId.get("docs")!.note).toContain("already exists");

  const forced = await run({ outputDir: outputRoot, force: true });
  expect(forced.byId.get("docs")!.worktree).toBe(join(outputRoot, "docs"));
});

test("stacked mode chains the refs instead of taking bases from the graph", async () => {
  const { result, byId } = await run({ mode: "stacked" });
  const order = result.projections.map((p) => p.projectionId);
  expect(byId.get(order[0]!)!.base).toBe("main");
  expect(byId.get(order[1]!)!.base).toBe(`drip/feature/${order[0]}`);
  expect(byId.get(order[2]!)!.base).toBe(`drip/feature/${order[1]}`);

  // The last ref in the chain carries everything, so it reconstructs the mega
  // branch exactly — which is what `push --projection stacked` would send.
  expect(gitOutput(["rev-parse", `drip/feature/${order[2]}^{tree}`], repoRoot).trim()).toBe(
    gitOutput(["rev-parse", "feature^{tree}"], repoRoot).trim(),
  );
});

test("stacked --only drags in the whole prefix, since that is what its chain means", async () => {
  const { result } = await run({ mode: "stacked", only: ["docs"] });
  const ids = result.projections.map((p) => p.projectionId);
  // Whatever the topological order is, everything up to `docs` is written.
  expect(ids[ids.length - 1]).toBe("docs");
  expect(ids.length).toBeGreaterThan(1);
  expect(result.projections.filter((p) => p.selected).map((p) => p.projectionId)).toEqual(["docs"]);
});

test("a projection already bound to an adopted PR is reported next to its own ref", async () => {
  const db = openStore(repoRoot);
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("report"),
    sliceBranch: "team/report-tab",
    prNumber: 373,
    prUrl: "https://example.com/pull/373",
    contentHash: "whatever",
    commitSha: "deadbeef",
    baseRef: "main",
    adopted: true,
  });

  const { byId } = await run();
  // drip never writes over a local copy of somebody else's branch: the
  // projection still materializes to drip's own ref, and the binding is
  // reported so the two can be diffed.
  expect(byId.get("report")!.ref).toBe("drip/feature/report");
  expect(byId.get("report")!.correspondence).toMatchObject({ prNumber: 373, branch: "team/report-tab", adopted: true });
  expect(localRefs()).not.toContain("team/report-tab");
});
