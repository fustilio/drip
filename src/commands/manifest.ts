import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  adoptionToJson,
  checkAdoption,
  fetchAdoptedHead,
  listProjectionCorrespondence,
  printAdoptionReport,
  recordAdoption,
} from "../adopt";
import { discoverAdoptionCandidates, discoveryToJson, printDiscoveryReport } from "../discover";
import { ghListOpenPrs, ghPrView } from "../github";
import { manifestSignature } from "../manifest";
import { deleteCorrespondence, openStore } from "../store";
import {
  baseFlag,
  command,
  git,
  jsonFlag,
  manifestFlag,
  openPlanContext,
  positiveInteger,
  repoFlag,
  requireAcyclicPlan,
  requireProjection,
  requireValidManifest,
  resolveRepo,
} from "./shared";

// `drip manifest adopt|discover|list|forget` — binding a semantic projection to
// a PR that already exists, rather than opening a new one. See docs/adr/0020
// for adoption and 0026 for discovery.

const remoteFlag = { kind: "parsed", parse: String, brief: "the git remote the PR branches live on", default: "origin" } as const;

const listCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string }, branch: string) => {
      const rows = listProjectionCorrespondence(openStore(resolveRepo(flags.repo)), branch);
      if (!rows.length) {
        console.log(`no projection PRs recorded for ${branch}`);
        return;
      }
      console.log(`PROJECTION PRs (${branch}):`);
      for (const r of rows) {
        console.log(
          `  ${r.projectionId} -> ${r.branch}${r.prNumber ? ` #${r.prNumber}` : ""} [${r.adopted ? "adopted" : "drip"}] base: ${r.baseRef ?? "?"}${r.prUrl ? ` ${r.prUrl}` : ""}`,
        );
      }
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch", parse: String, placeholder: "branch" }] },
    flags: { repo: repoFlag },
  },
  docs: { brief: "show every projection PR, and whether drip opened it or adopted it" },
});

const forgetCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string; projection: string }, branch: string) => {
      deleteCorrespondence(openStore(resolveRepo(flags.repo)), branch, manifestSignature(flags.projection));
      console.log(`forgot the correspondence for '${flags.projection}' on ${branch} — the PR and its branch are untouched`);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      projection: { kind: "parsed", parse: String, brief: "the projection id whose binding to drop" },
    },
  },
  docs: { brief: "drop a mis-binding, without touching the PR" },
});

// Read-only, and deliberately not a mode of `adopt`: adopt takes a decision and
// writes correspondence, this takes none and writes nothing (issue #17).
const discoverCommand = buildCommand({
  loader: async () =>
    command(async (flags: { repo?: string; base: string; json: boolean; manifest?: string; remote: string; limit: number }, branch: string) => {
      const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, json: flags.json });
      if (!ctx) return;

      requireAcyclicPlan(ctx.plan, "discover", ctx.jsonOut);
      const resolved = requireValidManifest({
        repoRoot: ctx.repoRoot,
        branch: ctx.branch,
        plan: ctx.plan,
        manifestPath: flags.manifest,
        jsonOut: ctx.jsonOut,
        because: "the projections to find PRs for aren't well-defined yet",
      });

      const report = await discoverAdoptionCandidates({
        git,
        db: ctx.db,
        repoRoot: ctx.repoRoot,
        branch: ctx.branch,
        baseBranch: ctx.baseBranch,
        mergeBase: ctx.mergeBase,
        plan: ctx.plan,
        resolved,
        remote: flags.remote,
        prs: ghListOpenPrs(ctx.repoRoot, flags.limit),
      });
      if (ctx.jsonOut) console.log(JSON.stringify(discoveryToJson(report)));
      else printDiscoveryReport(report);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      json: jsonFlag,
      manifest: manifestFlag,
      remote: remoteFlag,
      // `default` is the raw input, not the parsed value: it goes through the
      // same parser everything typed on the command line does.
      limit: { kind: "parsed", parse: positiveInteger("--limit"), brief: "how many open PRs to examine", default: "50" },
    },
  },
  docs: { brief: "which open PRs already are your projections, and the command to adopt each" },
});

const adoptCommand = buildCommand({
  loader: async () =>
    command(
      async (
        flags: { repo?: string; base: string; json: boolean; manifest?: string; remote: string; projection: string; pr: number; head: string; yes: boolean },
        branch: string,
      ) => {
        const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch, json: flags.json });
        if (!ctx) return;

        requireAcyclicPlan(ctx.plan, "adopt", ctx.jsonOut);

        // Adoption binds a real PR to a projection, so the manifest that
        // defines that projection has to hold together first — otherwise the
        // thing being bound isn't well-defined.
        const resolved = requireValidManifest({
          repoRoot: ctx.repoRoot,
          branch: ctx.branch,
          plan: ctx.plan,
          manifestPath: flags.manifest,
          jsonOut: ctx.jsonOut,
          because: "fix it before binding a PR to one of its projections",
        });
        requireProjection(resolved, flags.projection);

        const check = await checkAdoption({
          git,
          db: ctx.db,
          repoRoot: ctx.repoRoot,
          branch: ctx.branch,
          baseBranch: ctx.baseBranch,
          mergeBase: ctx.mergeBase,
          plan: ctx.plan,
          resolved,
          projectionId: flags.projection,
          head: flags.head,
          headSha: fetchAdoptedHead(git, ctx.repoRoot, flags.remote, flags.head),
          pr: ghPrView(ctx.repoRoot, flags.pr),
        });

        if (ctx.jsonOut) console.log(JSON.stringify(adoptionToJson(check)));
        else printAdoptionReport(check);
        if (!check.ok) process.exit(1);

        // The check is read-only; recording the correspondence is what makes a
        // later `push --manifest` treat someone else's branch as this
        // projection's own.
        if (!flags.yes) {
          if (!ctx.jsonOut) console.log("\nnot recorded: re-run with --yes to bind this projection to the PR.");
          return;
        }
        recordAdoption(ctx.db, ctx.branch, check);
        if (!ctx.jsonOut) console.log(`\nadopted: '${flags.projection}' now corresponds to #${check.pr.number} on ${check.head} — nothing was pushed.`);
      },
    ),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      json: jsonFlag,
      manifest: manifestFlag,
      remote: remoteFlag,
      // All three of projection, pr and head are required and cross-checked:
      // adoption on two out of three would be a heuristic, and a wrong guess
      // here becomes a future force-push over someone else's branch.
      projection: { kind: "parsed", parse: String, brief: "the projection id this PR corresponds to" },
      pr: { kind: "parsed", parse: positiveInteger("--pr"), brief: "the existing pull request's number" },
      head: { kind: "parsed", parse: String, brief: "the branch that PR is on" },
      yes: { kind: "boolean", brief: "record the binding (without this, the check runs and nothing is written)", default: false },
    },
  },
  docs: { brief: "bind a projection to a PR that already exists" },
});

export const manifestRoutes = buildRouteMap({
  routes: { adopt: adoptCommand, discover: discoverCommand, list: listCommand, forget: forgetCommand },
  docs: { brief: "bind semantic projections to PRs that already exist" },
});
