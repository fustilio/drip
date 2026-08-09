import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { GitBackend } from "./git-backend";
import type { CoarsenResult } from "./coarsen";
import { computePlan, type Hunk, type PlanResult } from "./planner";
import { resolveDiffSource, type DiffSource } from "./source";
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
export async function loadPlan(opts: {
  git: GitBackend;
  repoRoot: string;
  /** omit only with worktree: true, where the checked-out branch names the plan */
  branch?: string;
  baseBranch: string;
  /** plan the working tree — staged, unstaged and untracked — instead of committed history (issue #12) */
  worktree?: boolean;
}): Promise<{
  db: Database;
  mergeBase: string;
  plan: PlanResult;
  source: DiffSource;
}> {
  const { git, repoRoot, baseBranch } = opts;
  const source = resolveDiffSource(git, repoRoot, { branch: opts.branch, baseBranch, worktree: !!opts.worktree });
  const db = openStore(repoRoot);
  // Overrides, correspondence and manifests are keyed to the branch this work
  // lands on, not to the tree the content came from — so a worktree plan
  // inherits the decisions already made about the same change.
  const overrides = listOverrides(db, source.label);
  const plan = await computePlan({
    git,
    repoRoot,
    branch: source.label,
    baseBranch,
    overrides,
    sourceRef: source.ref,
    mergeBase: source.mergeBase,
  });
  return { db, mergeBase: source.mergeBase, plan, source };
}

// A coarsened plan in the exact shape verify already consumes: one "slice"
// per projection, in projection-topological order. Coarsening only decides
// which atomic slices are applied together, never which hunks exist or in what
// order within a file — so the same tree-hash check proves the coarsened
// projection reconstructs the mega branch, with no second verifier.
export function projectedUnits(plan: PlanResult, coarse: CoarsenResult | null): {
  order: string[];
  slices: Map<string, Hunk[]>;
  idToNum: Map<string, number>;
} {
  if (!coarse) return { order: plan.order!, slices: plan.slices, idToNum: plan.idToNum };
  const slices = new Map(coarse.projections.map((p) => [p.label, p.sliceIds.flatMap((id) => plan.slices.get(id)!)]));
  return { order: coarse.order, slices, idToNum: new Map(coarse.order.map((label, i) => [label, i])) };
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
  coarsen?: CoarsenResult | null;
  /** explicit units (a manifest's projections) — takes precedence over coarsen */
  units?: { order: string[]; slices: Map<string, Hunk[]>; idToNum: Map<string, number> };
  /** tree-ish the slices must reconstruct; defaults to `branch` */
  sourceRef?: string;
}): Promise<{ pass: boolean; tree: TreeHashResult; build: BuildOutcome }> {
  const { git, db, branch, repoRoot, mergeBase, plan, buildCmdOverride, noBuildCheck } = opts;
  const units = opts.units ?? projectedUnits(plan, opts.coarsen ?? null);
  const tree = await verifyTreeHash({
    git,
    repoRoot,
    branch,
    mergeBase,
    files: plan.files,
    order: units.order,
    slices: units.slices,
    sourceRef: opts.sourceRef,
    excluded: plan.excluded,
  });

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
    order: units.order,
    slices: units.slices,
    idToNum: units.idToNum,
    buildCmd,
    label: opts.coarsen || opts.units ? (id: string) => id : undefined, // projection ids are already their labels
  });
  return { pass: tree.pass && result.failures.length === 0, tree, build: { kind: "ran", buildCmd, result } };
}
