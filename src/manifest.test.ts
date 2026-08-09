import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjections } from "./coarsen";
import { ShellGitBackend } from "./git-backend";
import {
  emitManifest,
  findManifest,
  ManifestSchema,
  manifestCandidates,
  resolveManifest,
  unitsFromManifest,
  validateManifestAgainstGit,
  verificationUnits,
  writeManifest,
  type Manifest,
} from "./manifest";
import { computePlan, type PlanResult } from "./planner";
import { commit, git, makeTempRepo } from "./test-helpers";
import { verifyTreeHash } from "./verify";

const backend = new ShellGitBackend();
let repoRoot: string;
let cleanupRepo: () => void;
let mergeBase: string;

beforeAll(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-manifest-test-"));
  mkdirSync(join(repoRoot, "src", "appeals"), { recursive: true });
  mkdirSync(join(repoRoot, "src", "inbox"), { recursive: true });
  const write = (p: string, s: string) => writeFileSync(join(repoRoot, p), s);

  write("README.md", `# fixture\n`);
  write("src/appeals/format.ts", `export function formatAppeal(x: string) {\n  return x;\n}\n`);
  write(
    "src/appeals/report.ts",
    `import { formatAppeal } from "./format";\n\nconst P1 = 1;\nconst P2 = 2;\nconst P3 = 3;\nconst P4 = 4;\nconst P5 = 5;\nconst P6 = 6;\n\nexport function renderReport(x: string) {\n  return formatAppeal(x);\n}\n`,
  );
  write("src/inbox/columns.ts", `export function columns() {\n  return ["a"];\n}\n`);
  commit(repoRoot, "init");

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  write("README.md", `# fixture\n\ndocumented\n`);
  write("src/appeals/format.ts", `export function formatAppeal(x: string) {\n  return x.trim();\n}\n`);
  write(
    "src/appeals/report.ts",
    `import { formatAppeal, type Appeal } from "./format";\n\nconst P1 = 1;\nconst P2 = 2;\nconst P3 = 3;\nconst P4 = 4;\nconst P5 = 5;\nconst P6 = 6;\n\nexport function renderReport(x: string) {\n  return formatAppeal(x).toUpperCase();\n}\n`,
  );
  write("src/inbox/columns.ts", `export function columns() {\n  return ["a", "b"];\n}\n`);
  commit(repoRoot, "feature");
  mergeBase = backend.mergeBase("main", "feature", repoRoot);
});

afterAll(() => cleanupRepo());

const plan = async (): Promise<PlanResult> => computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });

const manifest = (overrides: Partial<Manifest> = {}): Manifest =>
  ManifestSchema.parse({
    version: 1,
    sourceBranch: "feature",
    projections: [
      { id: "formatter", atomicSlices: ["src/appeals/format.ts::formatAppeal"] },
      {
        id: "report",
        atomicSlices: ["src/appeals/report.ts::renderReport"],
        glue: ["src/appeals/report.ts::(file)"],
        dependsOn: ["formatter"],
      },
      { id: "inbox", atomicSlices: ["src/inbox/columns.ts::columns"] },
      { id: "docs", atomicSlices: ["README.md::(file)"] },
    ],
    ...overrides,
  });

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

test("a complete, coherent manifest resolves clean", async () => {
  const resolved = resolveManifest(await plan(), manifest(), { branch: "feature" });
  expect(resolved.findings).toEqual([]);
  expect(resolved.ok).toBe(true);
  expect(resolved.order.indexOf("formatter")).toBeLessThan(resolved.order.indexOf("report"));
  // Glue landed in the projection that declared it.
  expect(resolved.projections.find((p) => p.id === "report")!.sliceIds.length).toBe(2);
});

test("an atomic dependency crossing a projection boundary must be declared", async () => {
  const m = manifest();
  m.projections.find((p) => p.id === "report")!.dependsOn = [];
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  expect(codes(resolved)).toContain("dependency-removed");
  expect(resolved.ok).toBe(false);
});

test("a dependency may be widened past the atomic DAG without complaint", async () => {
  const m = manifest();
  m.projections.find((p) => p.id === "inbox")!.dependsOn = ["formatter", "docs"];
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  expect(resolved.findings).toEqual([]);
});

test("every atomic slice must be assigned or explicitly deferred with a reason", async () => {
  const m = manifest();
  m.projections = m.projections.filter((p) => p.id !== "docs");
  const missing = resolveManifest(await plan(), m, { branch: "feature" });
  expect(codes(missing)).toContain("unassigned-slice");

  m.defer = [{ slice: "README.md::(file)", reason: "ships with the release notes" }];
  const deferredOk = resolveManifest(await plan(), m, { branch: "feature" });
  expect(deferredOk.findings).toEqual([]);
  expect(deferredOk.deferred.map((d) => d.reason)).toEqual(["ships with the release notes"]);
});

test("a slice cannot be deferred while another projection depends on it", async () => {
  const m = manifest();
  m.projections = m.projections.filter((p) => p.id !== "formatter");
  m.projections.find((p) => p.id === "report")!.dependsOn = [];
  m.defer = [{ slice: "src/appeals/format.ts::formatAppeal", reason: "not this PR" }];
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  expect(codes(resolved)).toContain("dependency-removed");
});

test("a slice assigned twice is an error, not a silent last-wins", async () => {
  const m = manifest();
  m.projections.find((p) => p.id === "inbox")!.atomicSlices.push("src/appeals/format.ts::formatAppeal");
  expect(codes(resolveManifest(await plan(), m, { branch: "feature" }))).toContain("duplicate-assignment");
});

test("shared glue must live in an ancestor of every projection that needs it", async () => {
  const m = manifest();
  // inbox needs the same glue as report, but has no path to report.
  m.projections.find((p) => p.id === "inbox")!.glue = ["src/appeals/report.ts::(file)"];
  expect(codes(resolveManifest(await plan(), m, { branch: "feature" }))).toContain("glue-not-reachable");

  m.projections.find((p) => p.id === "inbox")!.dependsOn = ["report"];
  expect(codes(resolveManifest(await plan(), m, { branch: "feature" }))).not.toContain("glue-not-reachable");
});

test("a cyclic manifest is reported rather than topologically guessed at", async () => {
  const m = manifest();
  m.projections.find((p) => p.id === "formatter")!.dependsOn = ["report"];
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  expect(codes(resolved)).toContain("manifest-cycle");
});

test("an unmatched selector is reported as a migration task, never silently dropped", async () => {
  const m = manifest();
  m.projections.find((p) => p.id === "docs")!.atomicSlices = ["src/gone.ts::vanished"];
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  expect(codes(resolved)).toContain("unknown-selector");
  // ...and the now-orphaned slice surfaces too, so both halves of the migration
  // are visible in one report.
  expect(codes(resolved)).toContain("unassigned-slice");
});

test("an ordinal slice label works but warns, naming the durable selector to use", async () => {
  const m = manifest();
  m.projections.find((p) => p.id === "docs")!.atomicSlices = ["slice0"];
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  const warning = resolved.findings.find((f) => f.code === "ordinal-selector");
  expect(warning).toBeDefined();
  expect(warning!.severity).toBe("warning");
  expect(warning!.message).toContain("::");
  expect(resolved.ok).toBe(true);
});

test("a review budget is enforced unless the oversize is explicitly justified", async () => {
  const m = manifest({ budgets: { hunks: 1 } });
  const over = resolveManifest(await plan(), m, { branch: "feature" });
  expect(codes(over)).toContain("oversize");

  m.projections.find((p) => p.id === "report")!.oversizeReason = "the import and the call site are one change";
  const justified = resolveManifest(await plan(), m, { branch: "feature" });
  expect(justified.findings.filter((f) => f.projection === "report" && f.code === "oversize")).toEqual([]);
});

test("correspondence identity is the projection id, not the atomic slices under it", async () => {
  const units = unitsFromManifest(resolveManifest(await plan(), manifest(), { branch: "feature" }), "feature");
  expect(units.signature("report")).toBe("manifest:report");
  // Same id keeps its identity even as its membership changes.
  const m = manifest();
  m.projections.find((p) => p.id === "report")!.glue = [];
  m.projections.find((p) => p.id === "formatter")!.atomicSlices.push("src/appeals/report.ts::(file)");
  const moved = unitsFromManifest(resolveManifest(await plan(), m, { branch: "feature" }), "feature");
  expect(moved.signature("report")).toBe(units.signature("report"));
});

test("an emitted skeleton is a valid manifest that validates clean against the plan it came from", async () => {
  const p = await plan();
  const emitted = emitManifest(computeProjections(p), p, { branch: "feature", base: "main" });

  // Round-trip through the schema: whatever we write must be loadable.
  expect(() => ManifestSchema.parse(JSON.parse(JSON.stringify(emitted)))).not.toThrow();

  const resolved = resolveManifest(p, emitted, { branch: "feature" });
  expect(resolved.findings).toEqual([]);
  // Every atomic slice accounted for — a skeleton that dropped one would be a
  // trap, since the author would have to notice the omission themselves.
  expect(resolved.projections.flatMap((x) => x.sliceIds).sort()).toEqual([...p.slices.keys()].sort());

  const findings = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved });
  expect(findings).toEqual([]);
});

test("emitted ids are deterministic, unique, and name what the projection is", async () => {
  const p = await plan();
  const a = emitManifest(computeProjections(p), p, { branch: "feature", base: "main" });
  const b = emitManifest(computeProjections(p), p, { branch: "feature", base: "main" });
  const ids = a.projections.map((x) => x.id);
  expect(b.projections.map((x) => x.id)).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))).toBe(true);
});

test("the conventional manifest location is discovered, and prefers the committable one", () => {
  const candidates = manifestCandidates(repoRoot, "feature");
  expect(candidates[0]).toBe(join(repoRoot, ".drip", "projections", "feature.json"));
  expect(candidates[1]).toContain(join("drip", "projections", "feature.json"));
  expect(findManifest(repoRoot, "feature")).toBeNull();

  try {
    writeManifest(candidates[1]!, manifest());
    expect(findManifest(repoRoot, "feature")).toBe(candidates[1]!);
    writeManifest(candidates[0]!, manifest());
    expect(findManifest(repoRoot, "feature")).toBe(candidates[0]!);
    // Never silently clobber a hand-edited plan.
    expect(() => writeManifest(candidates[0]!, manifest())).toThrow(/already exists/);
    expect(() => writeManifest(candidates[0]!, manifest(), { force: true })).not.toThrow();
  } finally {
    rmSync(join(repoRoot, ".drip"), { recursive: true, force: true });
    rmSync(candidates[1]!, { force: true });
  }
});

test("the manifest's projections reconstruct the mega-branch tree", async () => {
  const p = await plan();
  const resolved = resolveManifest(p, manifest(), { branch: "feature" });
  const findings = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved });
  expect(findings).toEqual([]);
});

test("deferred slices are still covered by the tree check, so nothing can be quietly dropped", async () => {
  const p = await plan();
  const m = manifest();
  m.projections = m.projections.filter((x) => x.id !== "docs");
  m.defer = [{ slice: "README.md::(file)", reason: "release notes" }];
  const resolved = resolveManifest(p, m, { branch: "feature" });
  expect(resolved.ok).toBe(true);

  // The pushed units exclude the deferral; the verified units include it.
  expect(resolved.order).not.toContain("(deferred)");
  const units = verificationUnits(resolved);
  expect(units.order).toContain("(deferred)");

  const findings = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved });
  expect(findings).toEqual([]);

  // And the projections alone genuinely do *not* reconstruct it — which is why
  // the check has to include the remainder rather than be waived.
  const withoutDeferred = await verifyTreeHash({
    git: backend,
    repoRoot,
    branch: "feature",
    mergeBase,
    files: p.files,
    order: resolved.order,
    slices: resolved.units,
  });
  expect(withoutDeferred.pass).toBe(false);
});
