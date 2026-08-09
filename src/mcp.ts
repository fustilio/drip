#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { computeProjections, projectionsToJson } from "./coarsen";
import { DripError } from "./errors";
import { loadManifest, manifestReportToJson, resolveManifest, validateManifestAgainstGit } from "./manifest";
import { ShellGitBackend } from "./git-backend";
import { planToJson } from "./planner";
import { resolveRepoRoot } from "./repo";
import { sourceToJson } from "./source";
import { addOverride, listOverrides, openStore, removeOverride } from "./store";
import { loadPlan, runVerify } from "./workflow";

// Exposes the same read/write surface as the CLI's plan/verify/override
// commands to an MCP client — no push (real side effects, needs --yes) and
// no AI provider anywhere in here. See docs/adr/0009-ai-integration-external-not-bundled.md:
// this is the "expose data, don't bundle a model" half of M5's AI scope.
const git = new ShellGitBackend();

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(e: unknown) {
  const message = e instanceof DripError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new McpServer({ name: "drip", version: "0.1.0" });

server.tool(
  "drip_plan",
  "Compute drip's slice plan for a mega branch: files/symbols/hunks per slice, the slice DAG, fallback groups for hunks with no enclosing symbol, " +
    "and any override selectors that matched nothing. Set coarsen to also get review-sized candidate projections above the atomic slices. Read-only.",
  {
    repo: z.string().describe("path to the git repo"),
    branch: z.string().optional().describe("the mega branch; omit only with worktree=true, where the checked-out branch is used"),
    base: z.string().default("main"),
    coarsen: z.boolean().default(false).describe("also emit review-sized candidate projections grouping the atomic slices"),
    targetSlices: z.number().int().positive().optional().describe("with coarsen: merge by feature directory until at most this many projections remain"),
    worktree: z
      .boolean()
      .default(false)
      .describe(
        "plan the working tree — staged, unstaged and untracked changes on top of committed history — instead of committed history alone. " +
          "Read-only: builds a tree in a scratch index and never stages anything. The `source` field reports which files were uncommitted.",
      ),
  },
  async ({ repo, branch, base, coarsen, targetSlices, worktree }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const { plan, source } = await loadPlan({ git, repoRoot, branch, baseBranch: base, worktree });
      const sourceJson = sourceToJson(source);
      if (plan.hunks.length === 0) {
        return textResult({ ok: true, slices: [], edges: [], fallbackGroups: [], unmatchedOverrideSelectors: [], source: sourceJson });
      }
      const json = planToJson(plan);
      if (!coarsen || !plan.order) return textResult({ ...json, source: sourceJson });
      return textResult({ ...json, ...projectionsToJson(computeProjections(plan, { targetSlices })), source: sourceJson });
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.tool(
  "drip_verify",
  "Run drip's tree-hash invariant and per-slice standalone build check for a mega branch. Read-only (no branches pushed, no PRs touched).",
  {
    repo: z.string(),
    branch: z.string().optional(),
    base: z.string().default("main"),
    buildCmd: z.string().optional().describe("override the per-slice build command; defaults to `bunx tsc --noEmit` if tsconfig.json exists"),
    noBuildCheck: z.boolean().default(false),
    coarsen: z.boolean().default(false).describe("verify the coarsened candidate projections instead of the atomic slices"),
    targetSlices: z.number().int().positive().optional(),
    worktree: z.boolean().default(false).describe("verify that the slices reconstruct the working tree, rather than the branch tip"),
  },
  async ({ repo, branch, base, buildCmd, noBuildCheck, coarsen, targetSlices, worktree }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const { db, mergeBase, plan, source } = await loadPlan({ git, repoRoot, branch, baseBranch: base, worktree });
      if (plan.hunks.length === 0) return textResult({ ok: true, message: "no changes — nothing to verify", source: sourceToJson(source) });
      if (!plan.order) return textResult(planToJson(plan));

      const coarse = coarsen ? computeProjections(plan, { targetSlices }) : null;
      const result = await runVerify({
        git,
        db,
        branch: source.label,
        repoRoot,
        mergeBase,
        plan,
        buildCmdOverride: buildCmd,
        noBuildCheck,
        coarsen: coarse,
        sourceRef: source.ref,
      });
      const build =
        result.build.kind === "disabled"
          ? "disabled"
          : result.build.kind === "no-command"
            ? "skipped (no tsconfig.json, no buildCmd)"
            : result.build.result.failures.length
              ? { pass: false, failures: result.build.result.failures }
              : { pass: true, skipped: result.build.result.skipped };
      return textResult({ ok: result.pass, tree: result.tree.message, build, ...(coarse ? projectionsToJson(coarse) : {}), source: sourceToJson(source) });
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.tool(
  "drip_validate_plan",
  "Validate a semantic projection manifest against the current atomic slice plan. This is the write-back step for a proposed review plan: an agent reads drip_plan, groups the atomic slices into behaviourally coherent projections with intent/glue/dependsOn, and drip checks it deterministically — every slice assigned exactly once or explicitly deferred with a reason, no dependency dropped, each projection applies on its declared prerequisites, review budgets respected, and the whole graph still reconstructs the mega-branch tree. Also executes each projection's declared verification commands against its own materialized tree, so a projection that applies cleanly but isn't actually runnable fails here. Read-only with respect to git and GitHub, but it does run the manifest's commands; the manifest is advisory until passed to push.",
  {
    repo: z.string(),
    branch: z.string(),
    base: z.string().default("main"),
    manifestPath: z.string().describe("path to the projections manifest JSON"),
    runVerification: z
      .boolean()
      .default(true)
      .describe("execute each projection's declared verification commands against its own materialized tree; set false to skip"),
    requireVerification: z
      .boolean()
      .default(false)
      .describe("fail any projection that contains code and declares no verification command, even if it gives a verificationReason"),
  },
  async ({ repo, branch, base, manifestPath, runVerification, requireVerification }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const { db, mergeBase, plan } = await loadPlan({ git, repoRoot, branch, baseBranch: base });
      if (plan.hunks.length === 0) return textResult({ ok: true, message: "no changes — nothing to validate" });
      if (!plan.order) return textResult(planToJson(plan));

      const resolved = resolveManifest(plan, loadManifest(manifestPath), { branch, requireVerification });
      const checked = resolved.ok
        ? await validateManifestAgainstGit({ git, repoRoot, branch, mergeBase, plan, resolved, db, runVerification })
        : { findings: [], verification: [] };
      return textResult(manifestReportToJson(resolved, checked.findings, checked.verification));
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.tool(
  "drip_override_list",
  "List durable boundary overrides recorded for a branch.",
  { repo: z.string(), branch: z.string() },
  async ({ repo, branch }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const db = openStore(repoRoot);
      return textResult(listOverrides(db, branch));
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.tool(
  "drip_override_add",
  "Record a durable boundary override: force_merge unions two symbol groups into one slice, force_split pins a symbol group apart. " +
    "Selectors are 'file::QualifiedSymbolPath', taken from drip_plan's slice output. This is the write-back step for a boundary suggestion — " +
    "the override is a deterministic fact the moment it's recorded, and survives replanning.",
  {
    repo: z.string(),
    branch: z.string(),
    kind: z.enum(["force_merge", "force_split"]),
    selectorA: z.string(),
    selectorB: z.string().optional().describe("required for force_merge, must be absent for force_split"),
    note: z.string().optional(),
  },
  async ({ repo, branch, kind, selectorA, selectorB, note }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const db = openStore(repoRoot);
      // addOverride validates kind/selector format/selectorB presence rules
      // and throws DripError — same validation cli.ts's `override add` gets.
      addOverride(db, branch, kind, selectorA, selectorB ?? null, note ?? null);
      return textResult({ ok: true });
    } catch (e) {
      return errorResult(e);
    }
  },
);

server.tool(
  "drip_override_remove",
  "Remove a boundary override by id (see drip_override_list).",
  { repo: z.string(), id: z.number().int() },
  async ({ repo, id }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const db = openStore(repoRoot);
      return textResult({ removed: removeOverride(db, id) });
    } catch (e) {
      return errorResult(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
