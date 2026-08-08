#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assignChangeIds } from "./change-id";
import { ShellGitBackend } from "./git-backend";
import { computePlan, printPlan } from "./planner";
import { listOverrides, openStore, recordTiming } from "./store";
import { DEFAULT_BUILD_CMD, verifyPerSliceBuild, verifyTreeHash } from "./verify";

function usage(): never {
  console.error("usage: drip plan <branch> [--repo path] [--base branch] [--timing] [--assign-ids]");
  console.error("       drip verify <branch> [--repo path] [--base branch] [--timing] [--build-cmd cmd] [--no-build-check]");
  process.exit(2);
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
    },
  });

  const [command, branch] = positionals;
  if (!command || !branch || (command !== "plan" && command !== "verify")) usage();

  const git = new ShellGitBackend();
  const targetDir = values.repo ?? process.cwd();
  const repoRoot = git.showToplevel(targetDir);
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

  const db = openStore(repoRoot);
  const overrides = listOverrides(db, branch);
  const plan = await computePlan({ git, repoRoot, branch, baseBranch, overrides });
  printPlan(plan);

  if (!plan.order) {
    process.exit(1);
  }

  if (command === "plan") {
    if (values.timing) recordTiming(db, branch, "plan", plan.hunks.length, plan.slices.size, Date.now() - started);
    return;
  }

  // verify
  const mergeBase = git.mergeBase(baseBranch, branch, repoRoot);
  const treeResult = await verifyTreeHash({ git, repoRoot, branch, mergeBase, files: plan.files, order: plan.order!, slices: plan.slices });
  console.log(`\n${treeResult.message}`);

  let buildFailures: Array<{ slice: string; output: string }> = [];
  if (!values["no-build-check"]) {
    const buildCmd = values["build-cmd"] ?? (existsSync(join(repoRoot, "tsconfig.json")) ? DEFAULT_BUILD_CMD : null);
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
      buildFailures = result.failures;
      if (buildFailures.length) {
        console.log("BUILD CHECK: FAIL");
        for (const f of buildFailures) console.log(`  ${f.slice}:\n  ${f.output.split("\n").slice(0, 5).join("\n  ")}`);
      } else {
        console.log(`BUILD CHECK: PASS (${plan.order!.length} slices)`);
      }
    } else {
      console.log("BUILD CHECK: skipped (no tsconfig.json found — use --build-cmd to specify one)");
    }
  }

  if (values.timing) recordTiming(db, branch, "verify", plan.hunks.length, plan.slices.size, Date.now() - started);

  if (!treeResult.pass || buildFailures.length) process.exit(1);
}

main();
