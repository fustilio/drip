import { buildCommand } from "@stricli/core";
import { assignChangeIds } from "../change-id";
import { computeProjections, printProjections, projectionsToJson, type CoarsenResult } from "../coarsen";
import { DripError } from "../errors";
import { emitManifest, manifestCandidates, writeManifest } from "../manifest";
import { planToJson } from "../planner";
import { sourceToJson } from "../source";
import {
  baseFlag,
  coarsenFlag,
  command,
  git,
  jsonFlag,
  openPlanContext,
  printPlanOrExit,
  repoFlag,
  reportTiming,
  resolveRepo,
  targetSlicesFlag,
  worktreeFlag,
  type PlanContext,
} from "./shared";

type PlanFlags = {
  repo?: string;
  base: string;
  json: boolean;
  worktree: boolean;
  coarsen: boolean;
  targetSlices?: number;
  timing: boolean;
  assignIds: boolean;
  emitManifest: boolean;
  manifest?: string;
  force: boolean;
};

/**
 * The coarsen + emit-manifest stretch that `plan` and `verify` share. Both take
 * `--coarsen`; `push` does not, because it materializes atomic slices and
 * verifying a coarsened projection would prove something other than what gets
 * pushed.
 */
export function coarsenAndEmit(
  ctx: PlanContext,
  flags: { coarsen: boolean; targetSlices?: number; emitManifest: boolean; manifest?: string; force: boolean },
): CoarsenResult | null {
  const coarse = flags.coarsen ? computeProjections(ctx.plan, { targetSlices: flags.targetSlices }) : null;

  if (ctx.jsonOut) {
    console.log(JSON.stringify({ ...planToJson(ctx.plan), ...(coarse ? projectionsToJson(coarse) : {}), source: sourceToJson(ctx.source) }));
  } else if (coarse) {
    printProjections(coarse);
  }

  if (flags.emitManifest) {
    if (!coarse) throw new DripError("--emit-manifest needs --coarsen: the emitted skeleton is built from the coarsened projections");
    // `--manifest` names the destination here; on every other command it names
    // the input. Same flag, same meaning — "the manifest file for this run".
    const out = flags.manifest ?? manifestCandidates(ctx.repoRoot, ctx.branch)[0]!;
    writeManifest(out, emitManifest(coarse, ctx.plan, { branch: ctx.branch, base: ctx.baseBranch }), { force: flags.force });
    console.log(`\nwrote ${out} — a starting point, not a plan: give each projection a real id, title and intent before using it.`);
  }

  return coarse;
}

export const planCommand = buildCommand({
  loader: async () =>
    command(async (flags: PlanFlags, branch?: string) => {
      if (flags.worktree && flags.assignIds) {
        throw new DripError("--assign-ids rewrites commits, so it can't run against a working tree — commit first, then assign ids");
      }

      // Runs before the plan is loaded: it rewrites the branch the plan would
      // be read from.
      if (flags.assignIds) {
        const repoRoot = resolveRepo(flags.repo);
        const { rewritten, headSha } = assignChangeIds(git, repoRoot, branch!, flags.base);
        if (!flags.json) {
          if (rewritten.length) {
            console.log(`Assigned Change-Id trailers, rewrote ${rewritten.length} commit(s):`);
            for (const r of rewritten) console.log(`  ${r.old.slice(0, 7)} -> ${r.new.slice(0, 7)}`);
            console.log(`${branch} now points at ${headSha.slice(0, 7)}\n`);
          } else {
            console.log("All commits already have Change-Id trailers.\n");
          }
        }
      }

      const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, worktree: flags.worktree, json: flags.json });
      if (!ctx) return;

      printPlanOrExit(ctx);
      coarsenAndEmit(ctx, flags);

      if (flags.timing && !ctx.jsonOut) {
        reportTiming(ctx.db, ctx.branch, "plan", ctx.plan.hunks.length, ctx.plan.slices.size, Date.now() - ctx.startedAt);
      }
    }),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the mega branch to partition (optional with --worktree)", parse: String, optional: true, placeholder: "branch" }],
    },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      json: jsonFlag,
      worktree: worktreeFlag,
      coarsen: coarsenFlag,
      targetSlices: targetSlicesFlag,
      timing: { kind: "boolean", brief: "record and report how long planning took", default: false },
      assignIds: { kind: "boolean", brief: "inject Gerrit-format Change-Id trailers (rewrites the branch in place)", default: false },
      emitManifest: { kind: "boolean", brief: "write a valid manifest skeleton from the coarsened projections", default: false },
      manifest: { kind: "parsed", parse: String, brief: "where --emit-manifest writes to", optional: true },
      force: { kind: "boolean", brief: "let --emit-manifest overwrite an existing manifest", default: false },
    },
  },
  docs: { brief: "partition a mega branch into an atomic slice DAG" },
});
