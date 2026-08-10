import { buildCommand } from "@stricli/core";
import { collectReviewContext, printReviewContext, reviewContextToJson } from "../review-context";
import {
  baseFlag,
  command,
  git,
  jsonFlag,
  manifestFlag,
  openPlanContext,
  repoFlag,
  requireAcyclicPlan,
  requireProjection,
  requireValidManifest,
} from "./shared";

// Read-only in the strongest sense available here: it reads the manifest, the
// store and (unless --no-review) GitHub's comment listing, and has no code path
// that writes any of the three (issue #18).

type ReviewContextFlags = {
  repo?: string;
  base: string;
  json: boolean;
  manifest?: string;
  projection?: string;
  noReview: boolean;
};

export const reviewContextCommand = buildCommand({
  loader: async () =>
    command(async (flags: ReviewContextFlags, branch: string) => {
      const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, json: flags.json });
      if (!ctx) return;

      requireAcyclicPlan(ctx.plan, "report review context", ctx.jsonOut);
      const resolved = requireValidManifest({
        repoRoot: ctx.repoRoot,
        branch: ctx.branch,
        plan: ctx.plan,
        manifestPath: flags.manifest,
        jsonOut: ctx.jsonOut,
        because: "there is no well-defined projection to report on",
      });
      const only = flags.projection ?? null;
      if (only) requireProjection(resolved, only);

      const report = await collectReviewContext({
        git,
        db: ctx.db,
        repoRoot: ctx.repoRoot,
        branch: ctx.branch,
        baseBranch: ctx.baseBranch,
        mergeBase: ctx.mergeBase,
        plan: ctx.plan,
        resolved,
        only,
        includeReview: !flags.noReview,
      });
      if (ctx.jsonOut) console.log(JSON.stringify(reviewContextToJson(report)));
      else printReviewContext(report);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch the manifest projects", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      json: jsonFlag,
      manifest: manifestFlag,
      // On this command --projection names a projection *id*; on push and
      // materialize it names the base-selection mode. They were one entry in
      // one shared table before ADR 0029, which is how the same flag came to
      // mean two things. Per-command declaration is what makes both correct.
      projection: { kind: "parsed", parse: String, brief: "report on this projection id only", optional: true },
      noReview: { kind: "boolean", brief: "skip the GitHub read and report only what the repository knows", default: false },
    },
  },
  docs: { brief: "the state of a projection's review surface: PR, drift and open threads" },
});
