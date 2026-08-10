import { DripError } from "../errors";
import { ShellGitBackend, type GitBackend } from "../git-backend";
import {
  findManifest,
  loadManifest,
  manifestCandidates,
  printManifestReport,
  resolveManifest,
  validateManifestAgainstGit,
  type Finding,
  type ResolvedManifest,
} from "../manifest";
import { planToJson, printPlan, type PlanResult } from "../planner";
import { loadProfiles } from "../profiles";
import { resolveRepoRoot } from "../repo";
import { describeSource, sourceToJson, type DiffSource } from "../source";
import { openStore, recordTiming } from "../store";
import type { VerificationRun } from "../verification";
import { describeWorkspaceChecks } from "../workspace";
import { loadPlan, runVerify } from "../workflow";

// Shared by every command module: the flag fragments more than one command
// declares, the plan-loading spine they all run through, and the manifest
// helpers. See docs/adr/0029 for why the flags are declared per command rather
// than in one table.

export const git: GitBackend = new ShellGitBackend();

// --- flag fragments ---------------------------------------------------------
// Spread into a command's own `flags` object. Sharing the *fragment* is fine;
// sharing one table for every command is what ADR 0029 replaced.

export const repoFlag = {
  kind: "parsed",
  parse: String,
  brief: "repository to operate on (default: the working directory)",
  optional: true,
} as const;

export const baseFlag = {
  kind: "parsed",
  parse: String,
  brief: "the branch the mega branch is diffed against",
  default: "main",
} as const;

export const jsonFlag = {
  kind: "boolean",
  brief: "print machine-readable output and nothing else",
  default: false,
} as const;

export const manifestFlag = {
  kind: "parsed",
  parse: String,
  brief: "path to the semantic projection manifest",
  optional: true,
} as const;

export const worktreeFlag = {
  kind: "boolean",
  brief: "plan the working tree (staged, unstaged and untracked) instead of committed history",
  default: false,
} as const;

export const targetSlicesFlag = {
  kind: "parsed",
  parse: wholeNumber("--target-slices"),
  brief: "coarsening budget: how many review-sized projections to aim for",
  optional: true,
} as const;

export const coarsenFlag = {
  kind: "boolean",
  brief: "group slices into review-sized candidate projections",
  default: false,
} as const;

/** The four flags that gate a manifest's validation, shared by validate-plan, materialize and push. */
export const manifestCheckFlags = {
  noManifestCheck: { kind: "boolean", brief: "skip executing each projection's verification commands", default: false },
  strict: { kind: "boolean", brief: "promote every manifest warning to a failure", default: false },
  requireVerification: { kind: "boolean", brief: "a projection containing code must declare a runnable check", default: false },
  requireIntent: { kind: "boolean", brief: "a projection must state its intent", default: false },
} as const;

export const buildCheckFlags = {
  buildCmd: { kind: "parsed", parse: String, brief: "the per-slice build check command", optional: true },
  noBuildCheck: { kind: "boolean", brief: "skip the per-slice build check", default: false },
} as const;

// --- parsers ----------------------------------------------------------------
// Every coercion the CLI used to hand-roll after parseArgs handed back a
// string. Declared once, applied by the parser, reported before the command
// body ever runs.

export function wholeNumber(flag: string): (raw: string) => number {
  return (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new DripError(`${flag} must be a whole number, got '${raw}'`);
    return n;
  };
}

export function positiveInteger(flag: string): (raw: string) => number {
  return (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new DripError(`${flag} must be a positive whole number, got '${raw}'`);
    return n;
  };
}

export function fraction(flag: string): (raw: string) => number {
  return (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new DripError(`${flag} must be a fraction between 0 and 1, got '${raw}'`);
    return n;
  };
}

/** `--only a,b --only c` — repeatable and comma-separated both work, as they always have. */
export function splitIds(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- error handling ---------------------------------------------------------

/**
 * Wraps a command body so a DripError still prints as one clean `error: ...`
 * line and exits 1. Without it stricli catches the throw and prints
 * "Command failed, Error: ..." followed by a stack trace, which is the opposite
 * of the clean user-facing errors this CLI has had since M1.
 */
export function command<A extends unknown[]>(body: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await body(...args);
    } catch (e) {
      if (e instanceof DripError) {
        console.error(`error: ${e.message}`);
        process.exit(1);
      }
      throw e;
    }
  };
}

// --- the plan-loading spine -------------------------------------------------

export function resolveRepo(repo: string | undefined): string {
  return resolveRepoRoot(git, repo ?? process.cwd());
}

export type PlanContext = {
  db: ReturnType<typeof openStore>;
  repoRoot: string;
  /** the plan's identity: the checked-out branch in worktree mode, the positional otherwise */
  branch: string;
  baseBranch: string;
  mergeBase: string;
  plan: PlanResult;
  source: DiffSource;
  jsonOut: boolean;
  startedAt: number;
};

/**
 * Everything between "a command was named" and "the command has a plan to work
 * on": repo root, the worktree refusals, the plan itself, and the empty-diff
 * early exit.
 *
 * Returns null when there is nothing to slice — already reported, caller just
 * returns.
 */
export async function openPlanContext(opts: {
  repo?: string;
  base: string;
  branch?: string;
  worktree?: boolean;
  json?: boolean;
}): Promise<PlanContext | null> {
  const startedAt = Date.now();
  const repoRoot = resolveRepo(opts.repo);
  const jsonOut = !!opts.json;

  if (!opts.branch && !opts.worktree) {
    throw new DripError("name the mega branch, or pass --worktree to plan the working tree instead");
  }

  const { db, mergeBase, plan, source } = await loadPlan({ git, repoRoot, branch: opts.branch, baseBranch: opts.base, worktree: opts.worktree });
  const branch = source.label;
  if (!jsonOut) console.log(`${describeSource(source)}\n`);

  if (plan.hunks.length === 0) {
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, slices: [], edges: [], unmatchedOverrideSelectors: [], excluded: plan.excluded, source: sourceToJson(source) }));
    } else {
      console.log(`No changes between ${opts.base} and ${branch} — nothing to slice.`);
    }
    return null;
  }

  return { db, repoRoot, branch, baseBranch: opts.base, mergeBase, plan, source, jsonOut, startedAt };
}

// --- plan-shaped guards -----------------------------------------------------

/**
 * Every command that consumes a plan refuses a cyclic one, and the cycle
 * diagnostics (docs/adr/0013) are what makes the refusal useful — "resolve the
 * cycle first" alone doesn't say which slices are in it.
 */
export function requireAcyclicPlan(plan: PlanResult, verb: string, jsonOut: boolean): string[] {
  if (!plan.order) {
    if (!jsonOut) printPlan(plan);
    throw new DripError(`cannot ${verb} against a cyclic slice DAG — resolve the cycle first`);
  }
  return plan.order;
}

/**
 * Resolves the manifest for a command that reads one: an explicit --manifest,
 * else the conventional location. Same rule as validate-plan — discovery is for
 * reading, never for deciding what `push --yes` sends to GitHub.
 */
export function resolveManifestPath(repoRoot: string, branch: string, explicit: string | undefined, quiet: boolean): string {
  const path = explicit ?? findManifest(repoRoot, branch);
  if (!path) {
    throw new DripError(
      `no manifest found for '${branch}' — pass --manifest <path>, or create one at ${manifestCandidates(repoRoot, branch)[0]} ` +
        `(\`drip plan ${branch} --coarsen --emit-manifest\` writes a starting point)`,
    );
  }
  if (!explicit && !quiet) console.log(`using ${path}\n`);
  return path;
}

/**
 * The read-only half of the manifest path: find it, load it, resolve it against
 * the plan, and refuse if it doesn't hold together. `validate-plan`,
 * `materialize` and `push --manifest` want the git-backed checks on top of this
 * (checkManifest); `discover`, `adopt`, `review-context` and
 * `score --layer manifest` only need the projections to be well-defined.
 */
export function requireValidManifest(opts: {
  repoRoot: string;
  branch: string;
  plan: PlanResult;
  manifestPath: string | undefined;
  jsonOut: boolean;
  /** what can't proceed while the manifest is broken, in the caller's own terms */
  because: string;
}): ResolvedManifest {
  const { repoRoot, branch, plan, jsonOut } = opts;
  const resolved = resolveManifest(plan, loadManifest(resolveManifestPath(repoRoot, branch, opts.manifestPath, jsonOut)), {
    branch,
    profiles: loadProfiles(repoRoot),
    repoRoot,
  });
  if (!resolved.ok) {
    if (!jsonOut) printManifestReport(resolved);
    throw new DripError(`manifest validation failed — ${opts.because}`);
  }
  return resolved;
}

/** A projection id the caller named that this manifest doesn't define. */
export function requireProjection(resolved: ResolvedManifest, id: string): void {
  if (resolved.projections.some((p) => p.id === id)) return;
  throw new DripError(`no projection '${id}' in this manifest — known ids: ${resolved.projections.map((p) => p.id).join(", ")}`);
}

/**
 * Resolve a manifest against the plan and run the git-backed checks — the step
 * `validate-plan`, `materialize` and `push --manifest` all share. The git checks
 * only run once the manifest is structurally coherent; on a broken graph they
 * just produce noise blaming the same upstream cause repeatedly.
 */
export async function checkManifest(opts: {
  repoRoot: string;
  branch: string;
  mergeBase: string;
  plan: PlanResult;
  db: ReturnType<typeof openStore>;
  manifestPath: string;
  runVerification: boolean;
  requireVerification: boolean;
  requireIntent: boolean;
  /** what the projections must reconstruct — the working tree under --worktree */
  sourceRef?: string;
}) {
  const { repoRoot, branch, mergeBase, plan, db, sourceRef } = opts;
  const resolved = resolveManifest(plan, loadManifest(opts.manifestPath), {
    branch,
    requireVerification: opts.requireVerification,
    requireIntent: opts.requireIntent,
    profiles: loadProfiles(repoRoot),
    repoRoot,
  });
  const checked = resolved.ok
    ? await validateManifestAgainstGit({ git, repoRoot, branch, mergeBase, plan, resolved, db, sourceRef, runVerification: opts.runVerification })
    : { findings: [] as Finding[], verification: [] as VerificationRun[] };
  return { resolved, checked };
}

/**
 * --strict promotes every manifest warning to a failure. Useful in CI, where
 * "declares no verification commands" or "uses an ordinal selector" are things
 * you want to block on rather than read past.
 */
export function manifestFailed(resolved: { findings: { severity: string }[] }, extra: { severity: string }[], strict: boolean): boolean {
  return [...resolved.findings, ...extra].some((f) => f.severity === "error" || (strict && f.severity === "warning"));
}

// --- shared reporting -------------------------------------------------------

export function reportTiming(
  db: ReturnType<typeof openStore>,
  branch: string,
  cmd: "plan" | "verify",
  hunkCount: number,
  sliceCount: number,
  durationMs: number,
): void {
  recordTiming(db, branch, cmd, hunkCount, sliceCount, durationMs);
  console.log(`\nTIMING: ${cmd} took ${durationMs}ms (${hunkCount} hunks, ${sliceCount} slices)`);
}

/**
 * Formats runVerify's structured result as the CLI's text output. Shared by
 * `verify` and `push` — push must never skip verification, per the plan's own
 * M2 scope ("refuses to push if verify fails").
 */
export function printVerifyResult(result: Awaited<ReturnType<typeof runVerify>>, sliceCount: number): void {
  console.log(`\n${result.tree.message}`);

  const { build } = result;
  if (build.kind === "disabled") return;
  if (build.kind === "no-command") {
    // Never just "skipped". A vanished build check is how a projection that
    // reconstructs the tree but doesn't compile reaches a PR (issue #14), so
    // the line says what's missing and what this repo offers instead.
    console.log(
      `BUILD CHECK: skipped — no root tsconfig.json and no root \`typecheck\` script${build.checks.isJsWorkspace ? "" : " (not a JS/TS workspace)"}.`,
    );
    console.log("  A projection can reconstruct the mega branch's tree and still not compile on its own — pass --build-cmd, or give each");
    console.log("  projection a `verification` command (`--require-verification` makes that mandatory for projections containing code).");
    for (const line of describeWorkspaceChecks(build.checks)) console.log(`  ${line}`);
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
    console.log(
      `BUILD CHECK: PASS (\`${build.buildCmd}\`${build.source === "root-script" ? " — the repo's own root typecheck script" : ""}, ${sliceCount} slices${skipNote})`,
    );
  }
}

/** The plan printout plus the cyclic-DAG exit, shared by plan, verify and push. */
export function printPlanOrExit(ctx: PlanContext): string[] {
  if (!ctx.jsonOut) printPlan(ctx.plan);
  if (!ctx.plan.order) {
    if (ctx.jsonOut) console.log(JSON.stringify({ ...planToJson(ctx.plan), source: sourceToJson(ctx.source) }));
    process.exit(1);
  }
  return ctx.plan.order;
}
