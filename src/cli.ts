#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assignChangeIds } from "./change-id";
import { DripError } from "./errors";
import { ShellGitBackend, type GitBackend } from "./git-backend";
import { computePlan, printPlan, type PlanResult } from "./planner";
import { push } from "./push";
import { addOverride, listOverrides, openStore, recordTiming, removeOverride, type OverrideKind } from "./store";
import { DEFAULT_BUILD_CMD, verifyPerSliceBuild, verifyTreeHash } from "./verify";

function usage(): never {
  console.error("usage: drip plan <branch> [--repo path] [--base branch] [--timing] [--assign-ids]");
  console.error("       drip verify <branch> [--repo path] [--base branch] [--timing] [--build-cmd cmd] [--no-build-check]");
  console.error("       drip push <branch> [--repo path] [--base branch] [--build-cmd cmd] [--no-build-check] --yes | --dry-run");
  console.error(
    "       drip override add <branch> --kind force_merge|force_split --selector-a file::Symbol [--selector-b file::Symbol] [--note text] [--repo path]",
  );
  console.error("       drip override list <branch> [--repo path]");
  console.error("       drip override remove <id> [--repo path]");
  process.exit(2);
}

function resolveRepoRoot(git: GitBackend, targetDir: string): string {
  try {
    return git.showToplevel(targetDir);
  } catch {
    throw new DripError(`'${targetDir}' is not inside a git repository`);
  }
}

function resolveMergeBase(git: GitBackend, baseBranch: string, branch: string, repoRoot: string): string {
  try {
    return git.mergeBase(baseBranch, branch, repoRoot);
  } catch (e: any) {
    const stderr = String(e.stderr ?? e.message ?? "");
    if (/Not a valid object name|unknown revision/.test(stderr)) {
      throw new DripError(
        `branch '${branch}' or base '${baseBranch}' not found in this repo — if you just cloned, run ` +
          `\`git checkout ${branch}\` first (only the default branch is checked out locally after a fresh clone)`,
      );
    }
    throw new DripError(`could not compute merge-base of '${baseBranch}' and '${branch}': ${stderr.trim() || e.message}`);
  }
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

// Shared by `verify` and `push` — push must never skip this, per the plan's
// own M2 scope ("refuses to push if verify fails").
async function runVerification(opts: {
  git: GitBackend;
  repoRoot: string;
  branch: string;
  mergeBase: string;
  plan: PlanResult;
  buildCmdOverride: string | undefined;
  noBuildCheck: boolean;
}): Promise<{ pass: boolean }> {
  const { git, repoRoot, branch, mergeBase, plan, noBuildCheck } = opts;
  const treeResult = await verifyTreeHash({ git, repoRoot, branch, mergeBase, files: plan.files, order: plan.order!, slices: plan.slices });
  console.log(`\n${treeResult.message}`);

  let buildOk = true;
  if (!noBuildCheck) {
    const buildCmd = opts.buildCmdOverride ?? (existsSync(join(repoRoot, "tsconfig.json")) ? DEFAULT_BUILD_CMD : null);
    if (buildCmd) {
      const result = await verifyPerSliceBuild({
        git,
        repoRoot,
        mergeBase,
        files: plan.files,
        order: plan.order!,
        slices: plan.slices,
        idToNum: plan.idToNum,
        buildCmd,
      });
      if (result.failures.length) {
        buildOk = false;
        console.log(`BUILD CHECK: FAIL (\`${buildCmd}\`)`);
        for (const f of result.failures) {
          const lines = f.output.split("\n").filter((l) => l.trim().length > 0);
          const shown = lines.slice(0, 8);
          console.log(`  ${f.slice}:`);
          for (const line of shown) console.log(`    ${line}`);
          if (lines.length > shown.length) console.log(`    ... (${lines.length - shown.length} more lines)`);
        }
      } else {
        console.log(`BUILD CHECK: PASS (\`${buildCmd}\`, ${plan.order!.length} slices)`);
      }
    } else {
      console.log("BUILD CHECK: skipped (no tsconfig.json found — use --build-cmd to specify one)");
    }
  }

  return { pass: treeResult.pass && buildOk };
}

async function runOverrideCommand(git: GitBackend, positionals: string[], values: Record<string, unknown>) {
  const [, sub, arg] = positionals;
  const targetDir = (values.repo as string | undefined) ?? process.cwd();
  const repoRoot = resolveRepoRoot(git, targetDir);
  const db = openStore(repoRoot);

  if (sub === "add") {
    const branch = arg;
    if (!branch) throw new DripError("override add requires a branch: drip override add <branch> --kind ... --selector-a ...");
    const kind = values.kind as string | undefined;
    if (kind !== "force_merge" && kind !== "force_split") {
      throw new DripError("--kind must be 'force_merge' or 'force_split'");
    }
    const selectorA = values["selector-a"] as string | undefined;
    if (!selectorA) throw new DripError("--selector-a is required (format: file::QualifiedSymbolPath)");
    if (!selectorA.includes("::")) {
      throw new DripError(`--selector-a '${selectorA}' doesn't look like 'file::QualifiedSymbolPath' — missing '::'`);
    }
    const selectorB = values["selector-b"] as string | undefined;
    if (kind === "force_merge" && !selectorB) {
      throw new DripError("force_merge requires --selector-b as well");
    }
    if (kind === "force_split" && selectorB) {
      throw new DripError("force_split takes only --selector-a, not --selector-b");
    }
    if (selectorB && !selectorB.includes("::")) {
      throw new DripError(`--selector-b '${selectorB}' doesn't look like 'file::QualifiedSymbolPath' — missing '::'`);
    }
    addOverride(db, branch, kind as OverrideKind, selectorA, kind === "force_merge" ? selectorB! : null, (values.note as string) ?? null);
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
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      kind: { type: "string" },
      "selector-a": { type: "string" },
      "selector-b": { type: "string" },
      note: { type: "string" },
    },
  });

  const [command, branch] = positionals;
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

  if (command === "plan" && values["assign-ids"]) {
    const { rewritten, headSha } = assignChangeIds(git, repoRoot, branch, baseBranch);
    if (rewritten.length) {
      console.log(`Assigned Change-Id trailers, rewrote ${rewritten.length} commit(s):`);
      for (const r of rewritten) console.log(`  ${r.old.slice(0, 7)} -> ${r.new.slice(0, 7)}`);
      console.log(`${branch} now points at ${headSha.slice(0, 7)}\n`);
    } else {
      console.log("All commits already have Change-Id trailers.\n");
    }
  }

  resolveMergeBase(git, baseBranch, branch, repoRoot); // validate early, before opening the DB / running tree-sitter

  const db = openStore(repoRoot);
  const overrides = listOverrides(db, branch);
  const plan = await computePlan({ git, repoRoot, branch, baseBranch, overrides });

  if (plan.hunks.length === 0) {
    console.log(`No changes between ${baseBranch} and ${branch} — nothing to slice.`);
    return;
  }

  printPlan(plan);

  if (!plan.order) {
    process.exit(1);
  }

  if (command === "plan") {
    if (values.timing) reportTiming(db, branch, "plan", plan.hunks.length, plan.slices.size, Date.now() - started);
    return;
  }

  const mergeBase = resolveMergeBase(git, baseBranch, branch, repoRoot);
  const { pass } = await runVerification({
    git,
    repoRoot,
    branch,
    mergeBase,
    plan,
    buildCmdOverride: values["build-cmd"],
    noBuildCheck: !!values["no-build-check"],
  });

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

  const results = await push({ git, db, repoRoot, branch, baseBranch, mergeBase, plan, dryRun });
  console.log(dryRun ? "\nDRY RUN (no branches pushed, no PRs created):" : "\nPUSHED:");
  for (const r of results) {
    console.log(`  ${r.sliceLabel} -> ${r.branchName}${r.prUrl ? ` [${r.status}] ${r.prUrl}` : ""}`);
  }
}

main().catch((e) => {
  if (e instanceof DripError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
});
