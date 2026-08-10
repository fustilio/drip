import { buildCommand } from "@stricli/core";
import { manifestReportToJson, printManifestReport } from "../manifest";
import { materializeProjections, materializeToJson, printMaterializeReport } from "../materialize-local";
import {
  baseFlag,
  checkManifest,
  command,
  git,
  jsonFlag,
  manifestCheckFlags,
  manifestFailed,
  manifestFlag,
  openPlanContext,
  repoFlag,
  requireAcyclicPlan,
  resolveManifestPath,
  splitIds,
  worktreeFlag,
} from "./shared";

// `validate-plan` and `materialize` are the two manifest commands with no
// remote effects. Both read the manifest, so discovering the conventional
// location is safe and saves typing the same path every run — unlike `push`,
// where discovery would decide what gets sent to GitHub.

type SharedFlags = {
  repo?: string;
  base: string;
  json: boolean;
  worktree: boolean;
  manifest?: string;
  noManifestCheck: boolean;
  strict: boolean;
  requireVerification: boolean;
  requireIntent: boolean;
};

async function checkedManifest(flags: SharedFlags, branch: string | undefined, verb: string) {
  const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, worktree: flags.worktree, json: flags.json });
  if (!ctx) return null;

  const manifestPath = resolveManifestPath(ctx.repoRoot, ctx.branch, flags.manifest, ctx.jsonOut);
  requireAcyclicPlan(ctx.plan, verb, ctx.jsonOut);
  const { resolved, checked } = await checkManifest({
    repoRoot: ctx.repoRoot,
    branch: ctx.branch,
    mergeBase: ctx.mergeBase,
    plan: ctx.plan,
    db: ctx.db,
    manifestPath,
    sourceRef: ctx.source.ref,
    runVerification: !flags.noManifestCheck,
    requireVerification: flags.requireVerification,
    requireIntent: flags.requireIntent,
  });
  return { ctx, resolved, checked, failed: manifestFailed(resolved, checked.findings, flags.strict) };
}

const sharedFlags = {
  repo: repoFlag,
  base: baseFlag,
  json: jsonFlag,
  worktree: worktreeFlag,
  manifest: manifestFlag,
  ...manifestCheckFlags,
} as const;

export const validatePlanCommand = buildCommand({
  loader: async () =>
    command(async (flags: SharedFlags, branch?: string) => {
      const r = await checkedManifest(flags, branch, "validate");
      if (!r) return;
      const { ctx, resolved, checked, failed } = r;

      if (ctx.jsonOut) console.log(JSON.stringify(manifestReportToJson(resolved, checked.findings, checked.verification)));
      else printManifestReport(resolved, checked.findings, checked.verification, flags.strict);
      if (failed) process.exit(1);
    }),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the mega branch the manifest projects (optional with --worktree)", parse: String, optional: true, placeholder: "branch" }],
    },
    flags: sharedFlags,
  },
  docs: { brief: "check a semantic projection manifest against the current plan" },
});

type MaterializeFlags = SharedFlags & {
  projection: "flat-first" | "stacked";
  only?: readonly string[];
  output?: string;
  force: boolean;
};

export const materializeCommand = buildCommand({
  loader: async () =>
    command(async (flags: MaterializeFlags, branch?: string) => {
      const r = await checkedManifest(flags, branch, "materialize");
      if (!r) return;
      const { ctx, resolved, checked, failed } = r;

      // Materializing a manifest that doesn't hold together would produce refs
      // for projections drip has just said are wrong.
      const manifestJson = manifestReportToJson(resolved, checked.findings, checked.verification);
      if (failed) {
        if (ctx.jsonOut) console.log(JSON.stringify({ ok: false, manifest: manifestJson, materialize: null }));
        else {
          printManifestReport(resolved, checked.findings, checked.verification, flags.strict);
          console.error("\nmaterialize refused: manifest validation failed");
        }
        process.exit(1);
      }
      if (!ctx.jsonOut) {
        printManifestReport(resolved, checked.findings, checked.verification, flags.strict);
        console.log("");
      }

      const result = await materializeProjections({
        git,
        db: ctx.db,
        repoRoot: ctx.repoRoot,
        branch: ctx.branch,
        baseBranch: ctx.baseBranch,
        mergeBase: ctx.mergeBase,
        plan: ctx.plan,
        resolved,
        mode: flags.projection,
        only: splitIds(flags.only),
        outputDir: flags.output ?? null,
        force: flags.force,
      });
      if (ctx.jsonOut) console.log(JSON.stringify({ ok: result.ok, manifest: manifestJson, materialize: materializeToJson(result) }));
      else printMaterializeReport(result);
      if (!result.ok) process.exit(1);
    }),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "the mega branch the manifest projects (optional with --worktree)", parse: String, optional: true, placeholder: "branch" }],
    },
    flags: {
      ...sharedFlags,
      // Flat-first by default, unlike `push`: a manifest's dependsOn graph *is*
      // the flat-first base selection, and it's what validation and `manifest
      // adopt` both materialize. Stacked stays available for previewing what
      // `push` (whose own default is stacked) would send.
      projection: { kind: "enum", values: ["flat-first", "stacked"], brief: "how each projection's base is chosen", default: "flat-first" },
      only: { kind: "parsed", parse: String, brief: "materialize only these projection ids (repeatable, comma-separated)", variadic: true, optional: true },
      output: { kind: "parsed", parse: String, brief: "check each projection out into a worktree under this directory", optional: true },
      force: { kind: "boolean", brief: "move a ref that holds different content", default: false },
    },
  },
  docs: { brief: "write each projection to a local ref, and stop there" },
});
