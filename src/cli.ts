#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { assignChangeIds } from "./change-id";
import { computeProjections, printProjections, projectionsToJson } from "./coarsen";
import {
  emitManifest,
  findManifest,
  loadManifest,
  manifestCandidates,
  manifestReportToJson,
  printManifestReport,
  resolveManifest,
  unitsFromManifest,
  validateManifestAgainstGit,
  verificationUnits,
  writeManifest,
} from "./manifest";
import { DripError } from "./errors";
import { ShellGitBackend, type GitBackend } from "./git-backend";
import { planToJson, printPlan } from "./planner";
import { push, type PushUnits } from "./push";
import { resolveRepoRoot } from "./repo";
import { addOverride, listOverrides, openStore, recordTiming, removeOverride } from "./store";
import { loadPlan, runVerify } from "./workflow";

function usage(): never {
  console.error(
    "usage: drip plan <branch> [--repo path] [--base branch] [--timing] [--assign-ids] [--json] [--coarsen] [--target-slices n] [--emit-manifest [--manifest path] [--force]]",
  );
  console.error("       drip verify <branch> [--repo path] [--base branch] [--timing] [--coarsen] [--target-slices n] [--build-cmd cmd] [--no-build-check]");
  console.error("       drip validate-plan <branch> [--manifest path] [--repo path] [--base branch] [--json]");
  console.error(
    "       drip push <branch> [--repo path] [--base branch] [--projection stacked|flat-first] [--manifest path] [--build-cmd cmd] [--no-build-check] --yes | --dry-run",
  );
  console.error(
    "       drip override add <branch> --kind force_merge|force_split --selector-a file::Symbol [--selector-b file::Symbol] [--note text] [--repo path]",
  );
  console.error("       drip override list <branch> [--repo path]");
  console.error("       drip override remove <id> [--repo path]");
  console.error("       drip mcp   (starts an MCP stdio server exposing plan/verify/override as tools)");
  process.exit(2);
}

function reportTiming(
  db: ReturnType<typeof openStore>,
  branch: string,
  command: "plan" | "verify",
  hunkCount: number,
  sliceCount: number,
  durationMs: number,
) {
  recordTiming(db, branch, command, hunkCount, sliceCount, durationMs);
  console.log(`\nTIMING: ${command} took ${durationMs}ms (${hunkCount} hunks, ${sliceCount} slices)`);
}

// Formats runVerify's structured result as the CLI's text output. Shared by
// `verify` and `push` — push must never skip verification, per the plan's
// own M2 scope ("refuses to push if verify fails").
function printVerifyResult(result: Awaited<ReturnType<typeof runVerify>>, sliceCount: number): void {
  console.log(`\n${result.tree.message}`);

  const { build } = result;
  if (build.kind === "disabled") return;
  if (build.kind === "no-command") {
    console.log("BUILD CHECK: skipped (no tsconfig.json found — use --build-cmd to specify one)");
    return;
  }

  const skipNote = build.result.skipped ? `, ${build.result.skipped} cached` : "";
  if (build.result.failures.length) {
    console.log(`BUILD CHECK: FAIL (\`${build.buildCmd}\`${skipNote})`);
    for (const f of build.result.failures) {
      const lines = f.output.split("\n").filter((l) => l.trim().length > 0);
      const shown = lines.slice(0, 8);
      console.log(`  ${f.slice}:`);
      for (const line of shown) console.log(`    ${line}`);
      if (lines.length > shown.length) console.log(`    ... (${lines.length - shown.length} more lines)`);
    }
  } else {
    console.log(`BUILD CHECK: PASS (\`${build.buildCmd}\`, ${sliceCount} slices${skipNote})`);
  }
}

async function runOverrideCommand(git: GitBackend, positionals: string[], values: Record<string, unknown>) {
  const [, sub, arg] = positionals;
  const targetDir = (values.repo as string | undefined) ?? process.cwd();
  const repoRoot = resolveRepoRoot(git, targetDir);
  const db = openStore(repoRoot);

  if (sub === "add") {
    const branch = arg;
    if (!branch) throw new DripError("override add requires a branch: drip override add <branch> --kind ... --selector-a ...");
    const kind = (values.kind as string | undefined) ?? "";
    const selectorA = values["selector-a"] as string | undefined;
    if (!selectorA) throw new DripError("--selector-a is required (format: file::QualifiedSymbolPath)");
    const selectorB = (values["selector-b"] as string | undefined) ?? null;
    // addOverride validates kind/selector format/selectorB presence rules and
    // throws DripError — one place, not duplicated per caller.
    addOverride(db, branch, kind, selectorA, selectorB, (values.note as string) ?? null);
    console.log(`added ${kind} override for ${branch}`);
    return;
  }

  if (sub === "list") {
    const branch = arg;
    if (!branch) throw new DripError("override list requires a branch: drip override list <branch>");
    const overrides = listOverrides(db, branch);
    if (!overrides.length) {
      console.log(`no overrides for ${branch}`);
      return;
    }
    for (const o of overrides) {
      const pair = o.kind === "force_merge" ? `${o.selectorA} <-> ${o.selectorB}` : o.selectorA;
      console.log(`  [${o.id}] ${o.kind}: ${pair}${o.note ? `  (${o.note})` : ""}`);
    }
    return;
  }

  if (sub === "remove") {
    const idStr = arg;
    const id = Number(idStr);
    if (!idStr || !Number.isInteger(id)) throw new DripError("override remove requires a numeric id: drip override remove <id>");
    const removed = removeOverride(db, id);
    console.log(removed ? `removed override ${id}` : `no override with id ${id}`);
    return;
  }

  usage();
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      base: { type: "string", default: "main" },
      timing: { type: "boolean", default: false },
      "assign-ids": { type: "boolean", default: false },
      "build-cmd": { type: "string" },
      "no-build-check": { type: "boolean", default: false },
      projection: { type: "string", default: "stacked" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      coarsen: { type: "boolean", default: false },
      "target-slices": { type: "string" },
      manifest: { type: "string" },
      "emit-manifest": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      kind: { type: "string" },
      "selector-a": { type: "string" },
      "selector-b": { type: "string" },
      note: { type: "string" },
    },
  });

  const [command, branch] = positionals;

  if (command === "mcp") {
    await import("./mcp");
    return;
  }

  const git = new ShellGitBackend();

  if (command === "override") {
    await runOverrideCommand(git, positionals, values);
    return;
  }

  const isCommand = command === "plan" || command === "verify" || command === "push" || command === "validate-plan";
  if (!command || !branch || !isCommand) usage();

  const targetDir = values.repo ?? process.cwd();
  const repoRoot = resolveRepoRoot(git, targetDir);
  const baseBranch = values.base!;
  const started = Date.now();

  const jsonOut = !!values.json && (command === "plan" || command === "validate-plan");

  if (command === "plan" && values["assign-ids"]) {
    const { rewritten, headSha } = assignChangeIds(git, repoRoot, branch, baseBranch);
    if (!jsonOut) {
      if (rewritten.length) {
        console.log(`Assigned Change-Id trailers, rewrote ${rewritten.length} commit(s):`);
        for (const r of rewritten) console.log(`  ${r.old.slice(0, 7)} -> ${r.new.slice(0, 7)}`);
        console.log(`${branch} now points at ${headSha.slice(0, 7)}\n`);
      } else {
        console.log("All commits already have Change-Id trailers.\n");
      }
    }
  }

  const { db, mergeBase, plan } = await loadPlan({ git, repoRoot, branch, baseBranch });

  if (plan.hunks.length === 0) {
    if (jsonOut) console.log(JSON.stringify({ ok: true, slices: [], edges: [], unmatchedOverrideSelectors: [] }));
    else console.log(`No changes between ${baseBranch} and ${branch} — nothing to slice.`);
    return;
  }

  // --- validate-plan: the manifest's own command, no push, no side effects ---
  if (command === "validate-plan") {
    // Read-only, so discovering the conventional location is safe and saves
    // typing the same path every run.
    const manifestPath = values.manifest ?? findManifest(repoRoot, branch);
    if (!manifestPath) {
      throw new DripError(
        `no manifest found for '${branch}' — pass --manifest <path>, or create one at ${manifestCandidates(repoRoot, branch)[0]} ` +
          `(\`drip plan ${branch} --coarsen --emit-manifest\` writes a starting point)`,
      );
    }
    if (!values.manifest && !jsonOut) console.log(`using ${manifestPath}\n`);
    if (!plan.order) {
      printPlan(plan);
      throw new DripError("cannot validate a manifest against a cyclic slice DAG — resolve the cycle first");
    }
    const resolved = resolveManifest(plan, loadManifest(manifestPath), { branch });
    // The git-backed checks only make sense once the manifest is structurally
    // coherent; running them on a broken graph just produces noise.
    const gitFindings = resolved.ok
      ? await validateManifestAgainstGit({ git, repoRoot, branch, mergeBase, plan, resolved })
      : [];
    if (jsonOut) console.log(JSON.stringify(manifestReportToJson(resolved, gitFindings)));
    else printManifestReport(resolved, gitFindings);
    const failed = [...resolved.findings, ...gitFindings].some((f) => f.severity === "error");
    if (failed) process.exit(1);
    return;
  }

  // Coarsening needs an acyclic DAG, so it can only run after the plan is
  // known good — the cycle report below still comes out either way.
  const wantCoarsen = !!values.coarsen;
  const targetSlices = values["target-slices"] === undefined ? undefined : Number(values["target-slices"]);
  if (targetSlices !== undefined && !Number.isInteger(targetSlices)) {
    throw new DripError(`--target-slices must be a whole number, got '${values["target-slices"]}'`);
  }

  if (!jsonOut) printPlan(plan);

  if (!plan.order) {
    if (jsonOut) console.log(JSON.stringify(planToJson(plan)));
    process.exit(1);
  }

  const coarse = wantCoarsen ? computeProjections(plan, { targetSlices }) : null;
  if (jsonOut) console.log(JSON.stringify(coarse ? { ...planToJson(plan), ...projectionsToJson(coarse) } : planToJson(plan)));
  else if (coarse) printProjections(coarse);

  if (values["emit-manifest"]) {
    if (!coarse) throw new DripError("--emit-manifest needs --coarsen: the emitted skeleton is built from the coarsened projections");
    // `--manifest` names the destination here; on every other command it names
    // the input. Same flag, same meaning — "the manifest file for this run".
    const out = values.manifest ?? manifestCandidates(repoRoot, branch)[0]!;
    writeManifest(out, emitManifest(coarse, plan, { branch, base: baseBranch }), { force: !!values.force });
    console.log(`\nwrote ${out} — a starting point, not a plan: give each projection a real id, title and intent before using it.`);
  }

  if (command === "plan") {
    if (values.timing && !jsonOut) reportTiming(db, branch, "plan", plan.hunks.length, plan.slices.size, Date.now() - started);
    return;
  }

  // `push` materializes atomic slices; verifying a coarsened projection here
  // would prove something other than what gets pushed.
  if (coarse && command === "push") {
    throw new DripError("--coarsen is a planning mode — `drip push` materializes atomic slices. Use `drip plan --coarsen` / `drip verify --coarsen`.");
  }

  // A manifest defines the units `push` materializes, so verification must run
  // against those same units — verifying atomic slices and pushing projections
  // would prove the wrong thing. Validated first: pushing an incoherent
  // manifest is worse than not pushing at all.
  let manifestUnits: PushUnits | undefined;
  let manifestVerifyUnits: ReturnType<typeof verificationUnits> | undefined;
  // Unlike validate-plan, push does *not* auto-discover. A manifest left lying
  // around must never silently change what a `push --yes` sends to GitHub —
  // but staying quiet about one would be its own trap, so say it's there.
  if (!values.manifest && command === "push") {
    const found = findManifest(repoRoot, branch);
    if (found) console.log(`\nnote: a manifest exists at ${found}, but --manifest was not passed — pushing atomic slices.`);
  }
  if (values.manifest) {
    const resolved = resolveManifest(plan, loadManifest(values.manifest), { branch });
    const gitFindings = resolved.ok ? await validateManifestAgainstGit({ git, repoRoot, branch, mergeBase, plan, resolved }) : [];
    printManifestReport(resolved, gitFindings);
    if ([...resolved.findings, ...gitFindings].some((f) => f.severity === "error")) {
      console.error("\npush refused: manifest validation failed");
      process.exit(1);
    }
    manifestUnits = unitsFromManifest(resolved, branch);
    // Verification covers the deferred remainder too, so the tree check proves
    // nothing was lost; push still only materializes the projections.
    manifestVerifyUnits = verificationUnits(resolved);
  }

  const verifyResult = await runVerify({
    git,
    db,
    branch,
    repoRoot,
    mergeBase,
    plan,
    buildCmdOverride: values["build-cmd"],
    noBuildCheck: !!values["no-build-check"],
    coarsen: coarse,
    units: manifestVerifyUnits,
  });
  printVerifyResult(verifyResult, manifestUnits ? manifestUnits.order.length : coarse ? coarse.projections.length : plan.order.length);
  const pass = verifyResult.pass;

  if (command === "verify") {
    if (values.timing) reportTiming(db, branch, "verify", plan.hunks.length, plan.slices.size, Date.now() - started);
    if (!pass) process.exit(1);
    return;
  }

  // push
  if (!pass) {
    console.error("\npush refused: verify failed");
    process.exit(1);
  }

  const dryRun = !!values["dry-run"];
  if (!dryRun && !values.yes) {
    throw new DripError("push creates real branches and opens real PRs on GitHub — pass --yes to confirm, or --dry-run to preview first");
  }

  const projection = values.projection!;
  if (projection !== "stacked" && projection !== "flat-first") {
    throw new DripError(`--projection must be 'stacked' or 'flat-first', got '${projection}'`);
  }

  const results = await push({ git, db, repoRoot, branch, baseBranch, mergeBase, plan, dryRun, projection, units: manifestUnits });
  const mode = `${projection}${manifestUnits ? ", manifest" : ""}`;
  console.log(dryRun ? `\nDRY RUN (${mode}, no branches pushed, no PRs created):` : `\nPUSHED (${mode}):`);
  for (const r of results) {
    console.log(`  ${r.sliceLabel} -> ${r.branchName} [${r.status}] base: ${r.base}${r.prUrl ? ` ${r.prUrl}` : ""}`);
    if (r.note) console.log(`      ${r.note}`);
  }
  const blocked = results.filter((r) => r.status === "blocked");
  if (blocked.length) {
    console.error(`\n${blocked.length} slice(s) blocked — not pushed. See the notes above.`);
    process.exit(1);
  }
}

main().catch((e) => {
  if (e instanceof DripError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
});
