#!/usr/bin/env bun
import { buildApplication, buildCommand, buildRouteMap, run } from "@stricli/core";
import { manifestRoutes } from "./commands/manifest";
import { overrideRoutes } from "./commands/override";
import { planCommand } from "./commands/plan";
import { pushCommand } from "./commands/push";
import { reviewContextCommand } from "./commands/review-context";
import { scoreCommand } from "./commands/score";
import { stackRoutes } from "./commands/stack";
import { materializeCommand, validatePlanCommand } from "./commands/validate";
import { verifyCommand } from "./commands/verify";

// The CLI is only the shape of the interface: every command's flags, arguments
// and help text live with that command in src/commands/, and the bodies call
// the same modules the MCP server does. See docs/adr/0029 for why this replaced
// one shared flag table read by a chain of `if (command === ...)`.

const mcpCommand = buildCommand({
  loader: async () => async () => {
    await import("./mcp");
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: {} },
  docs: { brief: "start an MCP stdio server exposing plan/verify/override as tools" },
});

export const app = buildApplication(
  buildRouteMap({
    routes: {
      plan: planCommand,
      verify: verifyCommand,
      push: pushCommand,
      "validate-plan": validatePlanCommand,
      materialize: materializeCommand,
      "review-context": reviewContextCommand,
      score: scoreCommand,
      stack: stackRoutes,
      override: overrideRoutes,
      manifest: manifestRoutes,
      mcp: mcpCommand,
    },
    docs: { brief: "drip-feed a mega branch back into main as thin, reviewable PRs" },
  }),
  {
    name: "drip",
    // drip's flags have always been kebab-case and the README documents them
    // that way; stricli's own convention is camelCase. This accepts both, so
    // `--target-slices` keeps working and nobody's scripts break.
    scanner: { caseStyle: "allow-kebab-for-camel" },
  },
);

if (import.meta.main) await run(app, process.argv.slice(2), { process });
