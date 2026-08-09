#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { assignChangeIds } from "./change-id";
import { computeProjections, printProjections, projectionsToJson } from "./coarsen";
import { DripError } from "./errors";
import { ShellGitBackend, type GitBackend } from "./git-backend";
import { planToJson, printPlan } from "./planner";
import { push } from "./push";
import { resolveRepoRoot } from "./repo";
import { addOverride, listOverrides, openStore, recordTiming, removeOverride } from "./store";
import { loadPlan, runVerify } from "./workflow";

function usage(): never {
  console.error("usage: drip plan <branch> [--repo path] [--base branch] [--timing] [--assign-ids] [--json] [--coarsen] [--target-slices n]");
  console.error("       drip verify <branch> [--repo path] [--base branch] [--timing] [--coarsen] [--target-slices n] [--build-cmd cmd] [--no-build-check]");
  console.error(
    "       drip push <branch> [--repo path] [--base branch] [--projection stacked|flat-first] [--build-cmd cmd] [--no-build-check] --yes | --dry-run",
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

  if (!command || !branch || (command !== "plan" && command !== "verify" && command !== "push")) usage();

  const targetDir = values.repo ?? process.cwd();
  const repoRoot = resolveRepoRoot(git, targetDir);
  const baseBranch = values.base!;
  const started = Date.now();

  const jsonOut = !!values.json && command === "plan";

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

  if (command === "plan") {
    if (values.timing && !jsonOut) reportTiming(db, branch, "plan", plan.hunks.length, plan.slices.size, Date.now() - started);
    return;
  }

  // `push` materializes atomic slices; verifying a coarsened projection here
  // would prove something other than what gets pushed.
  if (coarse && command === "push") {
    throw new DripError("--coarsen is a planning mode — `drip push` materializes atomic slices. Use `drip plan --coarsen` / `drip verify --coarsen`.");
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
  });
  printVerifyResult(verifyResult, coarse ? coarse.projections.length : plan.order.length);
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

  const results = await push({ git, db, repoRoot, branch, baseBranch, mergeBase, plan, dryRun, projection });
  console.log(dryRun ? `\nDRY RUN (${projection}, no branches pushed, no PRs created):` : `\nPUSHED (${projection}):`);
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
