import { buildCommand } from "@stricli/core";
import { computeProjections } from "../coarsen";
import type { Hunk } from "../planner";
import { loadExpectedPartition, printScoreReport, scoreBoundaries, scoreToJson, type ScoreLayer } from "../score";
import {
  baseFlag,
  command,
  fraction,
  jsonFlag,
  manifestFlag,
  openPlanContext,
  repoFlag,
  requireAcyclicPlan,
  requireValidManifest,
  targetSlicesFlag,
  worktreeFlag,
} from "./shared";

// The M0 kill gate, and the same question one layer up for review candidates
// (issues #15, #16). Reads one file and the plan; writes nothing anywhere.

type ScoreFlags = {
  repo?: string;
  base: string;
  json: boolean;
  worktree: boolean;
  expected: string;
  layer: ScoreLayer;
  manifest?: string;
  targetSlices?: number;
  threshold?: number;
  includeFallback: boolean;
};

export const scoreCommand = buildCommand({
  loader: async () =>
    command(async (flags: ScoreFlags, branch?: string) => {
      const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, worktree: flags.worktree, json: flags.json });
      if (!ctx) return;

      const order = requireAcyclicPlan(ctx.plan, "score", ctx.jsonOut);

      // Each layer hands over the units it already produces — scoring never has
      // its own idea of what drip's partition is.
      let units: { order: string[]; slices: Map<string, Hunk[]> };
      if (flags.layer === "atomic") {
        const label = (id: string) => `slice${ctx.plan.idToNum.get(id)}`;
        units = { order: order.map(label), slices: new Map(order.map((id) => [label(id), ctx.plan.slices.get(id)!])) };
      } else if (flags.layer === "candidates") {
        const coarse = computeProjections(ctx.plan, { targetSlices: flags.targetSlices });
        units = { order: coarse.order, slices: new Map(coarse.projections.map((p) => [p.label, p.sliceIds.flatMap((s) => ctx.plan.slices.get(s)!)])) };
      } else {
        const resolved = requireValidManifest({
          repoRoot: ctx.repoRoot,
          branch: ctx.branch,
          plan: ctx.plan,
          manifestPath: flags.manifest,
          jsonOut: ctx.jsonOut,
          because: "there is no well-defined partition to score against",
        });
        units = { order: resolved.order, slices: resolved.units };
      }

      const result = scoreBoundaries({
        units,
        expected: loadExpectedPartition(flags.expected),
        layer: flags.layer,
        includeFallback: flags.includeFallback,
        threshold: flags.threshold,
      });
      if (ctx.jsonOut) console.log(JSON.stringify(scoreToJson(result)));
      else printScoreReport(result);
      if (!result.pass) process.exit(1);
    }),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the mega branch to score (optional with --worktree)", parse: String, optional: true, placeholder: "branch" }],
    },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      json: jsonFlag,
      worktree: worktreeFlag,
      expected: {
        kind: "parsed",
        parse: String,
        brief: 'the v1 hand-drawn partition to measure against ({"version":1,"units":[{"id":"...","selectors":["file::Symbol"]}]})',
      },
      layer: { kind: "enum", values: ["atomic", "candidates", "manifest"], brief: "which of drip's layers to score", default: "atomic" },
      manifest: manifestFlag,
      targetSlices: targetSlicesFlag,
      threshold: { kind: "parsed", parse: fraction("--threshold"), brief: "the gate, as a fraction (default: two-thirds)", optional: true },
      includeFallback: { kind: "boolean", brief: "score fallback groups too", default: false },
    },
  },
  docs: { brief: "measure drip's boundaries against a partition you drew by hand" },
});
