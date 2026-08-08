#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DripError } from "./errors";
import { ShellGitBackend } from "./git-backend";
import { computePlan, planToJson } from "./planner";
import { resolveMergeBase, resolveRepoRoot } from "./repo";
import { addOverride, listOverrides, openStore, removeOverride, type OverrideKind } from "./store";
import { DEFAULT_BUILD_CMD, verifyPerSliceBuild, verifyTreeHash } from "./verify";

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
      resolveMergeBase(git, base, branch, repoRoot);
      const db = openStore(repoRoot);
      const overrides = listOverrides(db, branch);
      const plan = await computePlan({ git, repoRoot, branch, baseBranch: base, overrides });
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
      const mergeBase = resolveMergeBase(git, base, branch, repoRoot);
      const db = openStore(repoRoot);
      const overrides = listOverrides(db, branch);
      const plan = await computePlan({ git, repoRoot, branch, baseBranch: base, overrides });
      if (plan.hunks.length === 0) return textResult({ ok: true, message: "no changes — nothing to verify" });
      if (!plan.order) return textResult({ ok: false, error: "dependency cycle in slice DAG" });

      const treeResult = await verifyTreeHash({ git, repoRoot, branch, mergeBase, files: plan.files, order: plan.order, slices: plan.slices });
      if (noBuildCheck) return textResult({ ok: treeResult.pass, tree: treeResult.message });

      const cmd = buildCmd ?? (existsSync(join(repoRoot, "tsconfig.json")) ? DEFAULT_BUILD_CMD : null);
      if (!cmd) return textResult({ ok: treeResult.pass, tree: treeResult.message, build: "skipped (no tsconfig.json, no buildCmd)" });

      const buildResult = await verifyPerSliceBuild({
        git,
        db,
        branch,
        repoRoot,
        mergeBase,
        files: plan.files,
        order: plan.order,
        slices: plan.slices,
        idToNum: plan.idToNum,
        buildCmd: cmd,
      });
      return textResult({
        ok: treeResult.pass && buildResult.failures.length === 0,
        tree: treeResult.message,
        build: buildResult.failures.length ? { pass: false, failures: buildResult.failures } : { pass: true, skipped: buildResult.skipped },
      });
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
      if (kind === "force_merge" && !selectorB) throw new DripError("force_merge requires selectorB");
      if (kind === "force_split" && selectorB) throw new DripError("force_split takes only selectorA, not selectorB");
      const repoRoot = resolveRepoRoot(git, repo);
      const db = openStore(repoRoot);
      addOverride(db, branch, kind as OverrideKind, selectorA, kind === "force_merge" ? selectorB! : null, note ?? null);
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
