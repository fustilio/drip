import { buildCommand } from "@stricli/core";
import { runVerify } from "../workflow";
import { coarsenAndEmit } from "./plan";
import {
  baseFlag,
  buildCheckFlags,
  coarsenFlag,
  command,
  git,
  openPlanContext,
  printPlanOrExit,
  printVerifyResult,
  repoFlag,
  reportTiming,
  targetSlicesFlag,
  worktreeFlag,
} from "./shared";

type VerifyFlags = {
  repo?: string;
  base: string;
  worktree: boolean;
  coarsen: boolean;
  targetSlices?: number;
  timing: boolean;
  buildCmd?: string;
  noBuildCheck: boolean;
  emitManifest: boolean;
  manifest?: string;
  force: boolean;
};

export const verifyCommand = buildCommand({
  loader: async () =>
    command(async (flags: VerifyFlags, branch?: string) => {
      const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, worktree: flags.worktree });
      if (!ctx) return;

      const order = printPlanOrExit(ctx);
      const coarse = coarsenAndEmit(ctx, flags);

      const result = await runVerify({
        git,
        db: ctx.db,
        branch: ctx.branch,
        repoRoot: ctx.repoRoot,
        mergeBase: ctx.mergeBase,
        plan: ctx.plan,
        buildCmdOverride: flags.buildCmd,
        noBuildCheck: flags.noBuildCheck,
        coarsen: coarse,
        sourceRef: ctx.source.ref,
      });
      printVerifyResult(result, coarse ? coarse.projections.length : order.length);

      if (flags.timing) reportTiming(ctx.db, ctx.branch, "verify", ctx.plan.hunks.length, ctx.plan.slices.size, Date.now() - ctx.startedAt);
      if (!result.pass) process.exit(1);
    }),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the mega branch to verify (optional with --worktree)", parse: String, optional: true, placeholder: "branch" }],
    },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      worktree: worktreeFlag,
      coarsen: coarsenFlag,
      targetSlices: targetSlicesFlag,
      timing: { kind: "boolean", brief: "record and report how long verification took", default: false },
      ...buildCheckFlags,
      emitManifest: { kind: "boolean", brief: "write a valid manifest skeleton from the coarsened projections", default: false },
      manifest: { kind: "parsed", parse: String, brief: "where --emit-manifest writes to", optional: true },
      force: { kind: "boolean", brief: "let --emit-manifest overwrite an existing manifest", default: false },
    },
  },
  docs: { brief: "check that the slices reconstruct the mega branch and each one builds" },
});
