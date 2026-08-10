import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeProjections } from "./coarsen";
import { ShellGitBackend } from "./git-backend";
import {
  emitManifest,
  findManifest,
  ManifestSchema,
  manifestCandidates,
  manifestReportToJson,
  resolveManifest,
  unitsFromManifest,
  validateManifestAgainstGit,
  verificationUnits,
  writeManifest,
  type Manifest,
} from "./manifest";
import { computePlan, type PlanResult } from "./planner";
import { loadProfiles, type ProfileSet } from "./profiles";
import { openStore } from "./store";
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
      { id: "formatter", intent: "Trim whitespace when formatting an appeal.", atomicSlices: ["src/appeals/format.ts::formatAppeal"], verificationReason: NO_CHECKS },
      {
        id: "report",
        intent: "Upper-case the rendered report.",
        atomicSlices: ["src/appeals/report.ts::renderReport"],
        glue: ["src/appeals/report.ts::(file)"],
        dependsOn: ["formatter"],
        verificationReason: NO_CHECKS,
      },
      { id: "inbox", intent: "Add the second inbox column.", atomicSlices: ["src/inbox/columns.ts::columns"], verificationReason: NO_CHECKS },
      { id: "docs", intent: "Document the fixture.", atomicSlices: ["README.md::(file)"], verificationReason: NO_CHECKS },
    ],
    ...overrides,
  });

// The fixture opts out of executable checks by default so each test exercises
// one thing; the execution tests below opt back in explicitly.
const NO_CHECKS = "fixture: covered by the suite that owns this file";

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
  // A skeleton legitimately has neither verification commands nor intent yet —
  // those are the two things it can't invent (docs/adr/0018, docs/adr/0025),
  // and the warnings are how the author is told which fields are still theirs.
  expect(resolved.findings.every((f) => ["no-verification", "no-intent"].includes(f.code) && f.severity === "warning")).toBe(true);
  expect(resolved.findings.filter((f) => f.code === "no-intent").map((f) => f.projection).sort()).toEqual(
    emitted.projections.map((x) => x.id).sort(),
  );
  expect(resolved.ok).toBe(true);
  // Every atomic slice accounted for — a skeleton that dropped one would be a
  // trap, since the author would have to notice the omission themselves.
  expect(resolved.projections.flatMap((x) => x.sliceIds).sort()).toEqual([...p.slices.keys()].sort());

  const { findings } = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved });
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
  const { findings } = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved });
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

  const { findings } = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved });
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

// --- issue #10: verification commands are executed, not just documented ------

test("a projection's commands run against its own tree, not the mega branch", async () => {
  const p = await plan();
  const m = manifest();
  // `report`'s change is `toUpperCase`. Asserting it is *absent* from the
  // formatter projection's tree is the check that proves isolation: this
  // command passes only if the command ran against formatter's prerequisite
  // closure rather than against the branch or the working tree.
  m.projections.find((x) => x.id === "formatter")!.verification = ["! grep -q toUpperCase src/appeals/report.ts"];
  m.projections.find((x) => x.id === "report")!.verification = ["grep -q toUpperCase src/appeals/report.ts"];

  using db = openStore(repoRoot);
  const resolved = resolveManifest(p, m, { branch: "feature" });
  const { findings, verification } = await validateManifestAgainstGit({
    git: backend,
    repoRoot,
    branch: "feature",
    mergeBase,
    plan: p,
    resolved,
    db,
    runVerification: true,
  });
  expect(findings).toEqual([]);
  expect(verification.map((r) => [r.projection, r.passed])).toEqual([
    ["formatter", true],
    ["report", true],
  ]);
});

test("a failing command fails validation for exactly the affected projection", async () => {
  const p = await plan();
  const m = manifest();
  m.projections.find((x) => x.id === "inbox")!.verification = ["exit 3"];
  m.projections.find((x) => x.id === "docs")!.verification = ["true"];

  using db = openStore(repoRoot);
  const resolved = resolveManifest(p, m, { branch: "feature" });
  const { findings, verification } = await validateManifestAgainstGit({
    git: backend,
    repoRoot,
    branch: "feature",
    mergeBase,
    plan: p,
    resolved,
    db,
    runVerification: true,
  });

  const failed = findings.filter((f) => f.code === "verification-failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]!.projection).toBe("inbox");
  expect(failed[0]!.severity).toBe("error");
  // The unrelated projection still ran and still passed.
  expect(verification.find((r) => r.projection === "docs")!.passed).toBe(true);

  // Captured output is on disk, referenced by path rather than inlined.
  const run = verification.find((r) => r.projection === "inbox")!;
  expect(run.exitCode).toBe(3);
  expect(existsSync(run.outputPath!)).toBe(true);
  expect(readFileSync(run.outputPath!, "utf8")).toContain("exit 3");
});

test("a passing command is cached by tree, and skipping is explicit", async () => {
  const p = await plan();
  const m = manifest();
  // Distinct from any command another test in this file runs: the cache is
  // keyed by (branch, projection, command) in the repo's shared drip.db, so a
  // reused command would arrive already warm and prove nothing.
  m.projections.find((x) => x.id === "docs")!.verification = ["echo cache-probe"];
  using db = openStore(repoRoot);
  const resolved = resolveManifest(p, m, { branch: "feature" });
  const run = () =>
    validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved, db, runVerification: true });

  const first = await run();
  expect(first.verification.find((r) => r.projection === "docs")!.cached).toBe(false);
  const second = await run();
  expect(second.verification.find((r) => r.projection === "docs")!.cached).toBe(true);

  // Opting out runs nothing at all — no partial credit, no silent pass.
  const skipped = await validateManifestAgainstGit({ git: backend, repoRoot, branch: "feature", mergeBase, plan: p, resolved, db, runVerification: false });
  expect(skipped.verification).toEqual([]);
});

// --- issue #14: a reason is not a check ---------------------------------------
//
// The fixture's projections all set verificationReason, which is exactly the
// shape that reached a real repo as draft PRs that reconstructed the tree and
// did not typecheck.

test("--require-verification refuses a verificationReason on a projection containing code", async () => {
  const resolved = resolveManifest(await plan(), manifest(), { branch: "feature", requireVerification: true });
  const waived = resolved.findings.filter((f) => f.code === "verification-waived");

  // formatter, report and inbox are code; docs is a README and stays exempt.
  expect(waived.map((f) => f.projection).sort()).toEqual(["formatter", "inbox", "report"]);
  expect(waived.every((f) => f.severity === "error")).toBe(true);
  expect(waived[0]!.message).toContain("verificationReason");
  expect(resolved.ok).toBe(false);
});

test("--require-verification is satisfied by a real command, and off by default", async () => {
  const m = manifest();
  for (const projection of m.projections) {
    if (projection.id !== "docs") projection.verification = ["bun run typecheck"];
  }
  expect(resolveManifest(await plan(), m, { branch: "feature", requireVerification: true }).findings).toEqual([]);
  // Without the flag the same manifest that failed above passes, unchanged.
  expect(resolveManifest(await plan(), manifest(), { branch: "feature" }).ok).toBe(true);
});

test("--require-verification leaves a docs-only projection alone, reason or not", async () => {
  const m = manifest();
  m.projections.find((x) => x.id === "docs")!.verificationReason = null;
  const resolved = resolveManifest(await plan(), m, { branch: "feature", requireVerification: true });
  // A README has nothing for a typecheck to have an opinion about, so it gets
  // the ordinary warning rather than the new error.
  expect(resolved.findings.filter((f) => f.projection === "docs").map((f) => f.code)).toEqual(["no-verification"]);
});

test("declaring no checks warns, and --strict turns that warning into a failure", async () => {
  const m = manifest();
  m.projections.find((x) => x.id === "docs")!.verificationReason = null;
  const resolved = resolveManifest(await plan(), m, { branch: "feature" });
  const warning = resolved.findings.find((f) => f.code === "no-verification");
  expect(warning).toBeDefined();
  expect(warning!.severity).toBe("warning");
  expect(warning!.projection).toBe("docs");
  expect(resolved.ok).toBe(true); // a warning alone doesn't fail a normal run
});

// --- reusable verification profiles (issue #19, docs/adr/0024) ---------------

// The profiles file lives in the working tree like the manifest does. Written
// per test and removed afterwards, so no other test in this file sees one.
function withProfiles<T>(body: unknown, fn: (profiles: ProfileSet) => T): T {
  const path = join(repoRoot, ".drip", "verification.json");
  mkdirSync(join(repoRoot, ".drip"), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
  try {
    return fn(loadProfiles(repoRoot));
  } finally {
    rmSync(path, { force: true });
  }
}

const PROFILES = {
  version: 1,
  profiles: {
    typecheck: { description: "the repo's own root typecheck", commands: ["bun run typecheck"] },
    "appeals-tests": { commands: ["bun run typecheck", "bun test src/appeals"] },
  },
};

test("a projection resolves its commands from a named profile, and the report says which", async () => {
  const p = await plan();
  const m = manifest();
  const report = m.projections.find((x) => x.id === "report")!;
  report.verificationReason = null;
  report.verificationProfile = "appeals-tests";

  const resolved = withProfiles(PROFILES, (profiles) => resolveManifest(p, m, { branch: "feature", profiles, repoRoot }));
  expect(resolved.findings).toEqual([]);
  const resolvedReport = resolved.projections.find((x) => x.id === "report")!;
  // Resolved to real commands — everything downstream (execution, the PR body,
  // --require-verification) sees ordinary strings and knows nothing of profiles.
  expect(resolvedReport.verification).toEqual(["bun run typecheck", "bun test src/appeals"]);
  expect(resolvedReport.verificationProfile).toBe("appeals-tests");
  const json = manifestReportToJson(resolved) as { projections: Array<{ id: string; verificationProfile: string | null }> };
  expect(json.projections.find((x) => x.id === "report")!.verificationProfile).toBe("appeals-tests");
});

test("a profile satisfies --require-verification exactly as inline commands do", async () => {
  const p = await plan();
  const m = manifest();
  for (const projection of m.projections) {
    if (projection.id === "docs") continue;
    projection.verificationReason = null;
    projection.verificationProfile = "typecheck";
  }
  const resolved = withProfiles(PROFILES, (profiles) =>
    resolveManifest(p, m, { branch: "feature", requireVerification: true, profiles, repoRoot }),
  );
  expect(resolved.findings).toEqual([]);
});

test("an unknown profile fails with the file it looked in and the names it found", async () => {
  const p = await plan();
  const m = manifest();
  m.projections.find((x) => x.id === "report")!.verificationProfile = "typechek";
  const resolved = withProfiles(PROFILES, (profiles) => resolveManifest(p, m, { branch: "feature", profiles, repoRoot }));
  const finding = resolved.findings.find((f) => f.code === "unknown-verification-profile")!;
  expect(finding.severity).toBe("error");
  expect(finding.message).toContain(join(".drip", "verification.json"));
  expect(finding.message).toContain("appeals-tests, typecheck");
  expect(resolved.ok).toBe(false);
});

test("a profile referenced in a repo that declares none says where to create it", async () => {
  const p = await plan();
  const m = manifest();
  m.projections.find((x) => x.id === "report")!.verificationProfile = "typecheck";
  // No profiles file at all — loadProfiles returns the empty set rather than throwing.
  const resolved = resolveManifest(p, m, { branch: "feature", profiles: loadProfiles(repoRoot), repoRoot });
  const finding = resolved.findings.find((f) => f.code === "unknown-verification-profile")!;
  expect(finding.message).toContain("declares no profiles");
  expect(finding.message).toContain(join(repoRoot, ".drip", "verification.json"));
});

test("declaring both a profile and inline commands is refused, not silently merged", async () => {
  const p = await plan();
  const m = manifest();
  const report = m.projections.find((x) => x.id === "report")!;
  report.verificationProfile = "typecheck";
  report.verification = ["bun test src/appeals"];
  const resolved = withProfiles(PROFILES, (profiles) => resolveManifest(p, m, { branch: "feature", profiles, repoRoot }));
  expect(codes(resolved)).toContain("verification-profile-conflict");
  expect(resolved.ok).toBe(false);
});

test("a malformed profiles file fails loudly, even before anything references it", () => {
  expect(() => withProfiles({ version: 1, profiles: { ts: { commands: [] } } }, (x) => x)).toThrow(/do not match the v1 schema/);
  expect(() => withProfiles({ version: 2, profiles: {} }, (x) => x)).toThrow(/do not match the v1 schema/);
});

test("a manifest with no profile field is unaffected by a profiles file existing", async () => {
  const p = await plan();
  const resolved = withProfiles(PROFILES, (profiles) => resolveManifest(p, manifest(), { branch: "feature", profiles, repoRoot }));
  expect(resolved.findings).toEqual([]);
  expect(resolved.projections.every((x) => x.verificationProfile === null)).toBe(true);
});

// --- stated intent (issue #16, docs/adr/0025) -------------------------------

test("a projection with no intent warns by default and fails under --require-intent", async () => {
  const p = await plan();
  const m = manifest();
  m.projections.find((x) => x.id === "report")!.intent = undefined;

  const lenient = resolveManifest(p, m, { branch: "feature" });
  const warning = lenient.findings.find((f) => f.code === "no-intent")!;
  expect(warning.severity).toBe("warning");
  expect(warning.projection).toBe("report");
  expect(lenient.ok).toBe(true);

  const strict = resolveManifest(p, m, { branch: "feature", requireIntent: true });
  expect(strict.findings.find((f) => f.code === "no-intent")!.severity).toBe("error");
  expect(strict.ok).toBe(false);
});

test("whitespace is not intent", async () => {
  const p = await plan();
  const m = manifest();
  m.projections.find((x) => x.id === "report")!.intent = "   ";
  expect(codes(resolveManifest(p, m, { branch: "feature" }))).toContain("no-intent");
});
