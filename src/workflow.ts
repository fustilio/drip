import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { GitBackend } from "./git-backend";
import { computePlan, type PlanResult } from "./planner";
import { resolveMergeBase } from "./repo";
import { listOverrides, openStore } from "./store";
import { DEFAULT_BUILD_CMD, verifyPerSliceBuild, verifyTreeHash, type TreeHashResult, type BuildCheckResult } from "./verify";

// The "load a plan" step -- merge-base, store, overrides, computePlan -- was
// duplicated three ways (cli.ts's plan/verify/push shared one call, but
// mcp.ts's drip_plan and drip_verify each redid it) and cli.ts additionally
// resolved the merge-base twice per run. One call here, one merge-base
// resolution, reused by every caller.
//
// Doesn't throw on an empty diff or a DAG cycle -- those are valid plan
// states, not failures. Callers inspect plan.hunks.length / plan.order
// exactly as before.
export async function loadPlan(opts: { git: GitBackend; repoRoot: string; branch: string; baseBranch: string }): Promise<{
  db: Database;
  mergeBase: string;
  plan: PlanResult;
}> {
  const { git, repoRoot, branch, baseBranch } = opts;
  const mergeBase = resolveMergeBase(git, baseBranch, branch, repoRoot);
  const db = openStore(repoRoot);
  const overrides = listOverrides(db, branch);
  const plan = await computePlan({ git, repoRoot, branch, baseBranch, overrides });
  return { db, mergeBase, plan };
}

// Three states, not two: "--no-build-check was passed" and "no tsconfig.json
// and no --build-cmd" both mean no build ran, but cli.ts prints a different
// (or no) line for each -- collapsing them to one null would lose that.
export type BuildOutcome = { kind: "disabled" } | { kind: "no-command" } | { kind: "ran"; buildCmd: string; result: BuildCheckResult };

// The tree-hash invariant + per-slice build check, as one structured result
// instead of interleaved console output. Precondition: plan.hunks.length > 0
// && plan.order !== null -- callers already checked (same trust boundary as
// the non-null assertions this replaces).
export async function runVerify(opts: {
  git: GitBackend;
  db: Database;
  branch: string;
  repoRoot: string;
  mergeBase: string;
  plan: PlanResult;
  buildCmdOverride: string | undefined;
  noBuildCheck: boolean;
}): Promise<{ pass: boolean; tree: TreeHashResult; build: BuildOutcome }> {
  const { git, db, branch, repoRoot, mergeBase, plan, buildCmdOverride, noBuildCheck } = opts;
  const tree = await verifyTreeHash({ git, repoRoot, branch, mergeBase, files: plan.files, order: plan.order!, slices: plan.slices });

  if (noBuildCheck) return { pass: tree.pass, tree, build: { kind: "disabled" } };

  const buildCmd = buildCmdOverride ?? (existsSync(join(repoRoot, "tsconfig.json")) ? DEFAULT_BUILD_CMD : null);
  if (!buildCmd) return { pass: tree.pass, tree, build: { kind: "no-command" } };

  const result = await verifyPerSliceBuild({
    git,
    db,
    branch,
    repoRoot,
    mergeBase,
    files: plan.files,
    order: plan.order!,
    slices: plan.slices,
    idToNum: plan.idToNum,
    buildCmd,
  });
  return { pass: tree.pass && result.failures.length === 0, tree, build: { kind: "ran", buildCmd, result } };
}
