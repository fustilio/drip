#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DripError } from "./errors";
import { ShellGitBackend } from "./git-backend";
import { planToJson } from "./planner";
import { resolveRepoRoot } from "./repo";
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
  "Compute drip's slice plan for a mega branch: files/symbols/hunks per slice, the slice DAG, and any override selectors that matched nothing. Read-only.",
  { repo: z.string().describe("path to the git repo"), branch: z.string(), base: z.string().default("main") },
  async ({ repo, branch, base }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const { plan } = await loadPlan({ git, repoRoot, branch, baseBranch: base });
      return textResult(plan.hunks.length === 0 ? { ok: true, slices: [], edges: [], unmatchedOverrideSelectors: [] } : planToJson(plan));
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
    branch: z.string(),
    base: z.string().default("main"),
    buildCmd: z.string().optional().describe("override the per-slice build command; defaults to `bunx tsc --noEmit` if tsconfig.json exists"),
    noBuildCheck: z.boolean().default(false),
  },
  async ({ repo, branch, base, buildCmd, noBuildCheck }) => {
    try {
      const repoRoot = resolveRepoRoot(git, repo);
      const { db, mergeBase, plan } = await loadPlan({ git, repoRoot, branch, baseBranch: base });
      if (plan.hunks.length === 0) return textResult({ ok: true, message: "no changes — nothing to verify" });
      if (!plan.order) return textResult(planToJson(plan));

      const result = await runVerify({ git, db, branch, repoRoot, mergeBase, plan, buildCmdOverride: buildCmd, noBuildCheck });
      const build =
        result.build.kind === "disabled"
          ? "disabled"
          : result.build.kind === "no-command"
            ? "skipped (no tsconfig.json, no buildCmd)"
            : result.build.result.failures.length
              ? { pass: false, failures: result.build.result.failures }
              : { pass: true, skipped: result.build.result.skipped };
      return textResult({ ok: result.pass, tree: result.tree.message, build });
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
