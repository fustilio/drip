import { buildCommand, buildRouteMap } from "@stricli/core";
import { DripError } from "../errors";
import {
  collectStackStatus,
  linearChains,
  linkStacks,
  nodesFromCorrespondence,
  printStackLinks,
  printStackStatus,
  stackLinksToJson,
  stackStatusToJson,
} from "../stacks";
import { listCorrespondence, openStore } from "../store";
import { command, jsonFlag, repoFlag, resolveRepo } from "./shared";

// `drip stack status|link` — the GitHub stack a set of drip's PRs forms, and
// grouping them into one on GitHub. See docs/adr/0030-github-stacks.md.
//
// Both read correspondence rather than replanning: a stack groups PRs that
// exist, and correspondence is drip's record of which PRs it opened and what
// base each targets. Whether the *plan* has moved underneath those PRs is a
// different question, and `drip review-context` is where it's answered.

const statusCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string; json: boolean }, branch: string) => {
      const repoRoot = resolveRepo(flags.repo);
      const report = collectStackStatus({
        repoRoot,
        branch,
        correspondence: listCorrespondence(openStore(repoRoot), branch),
      });
      if (flags.json) console.log(JSON.stringify(stackStatusToJson(report)));
      else printStackStatus(report);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch", parse: String, placeholder: "branch" }] },
    flags: { repo: repoFlag, json: jsonFlag },
  },
  docs: { brief: "how drip's PRs chain, and what GitHub has grouped into a stack" },
});

const linkCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string; json: boolean; yes: boolean; dryRun: boolean }, branch: string) => {
      if (!flags.dryRun && !flags.yes) {
        throw new DripError("stack link creates a real stack on GitHub — pass --yes to confirm, or --dry-run to preview first");
      }
      const repoRoot = resolveRepo(flags.repo);
      const { nodes } = nodesFromCorrespondence(listCorrespondence(openStore(repoRoot), branch));
      const { chains, solitary } = linearChains(nodes);
      if (!chains.length) {
        const detail = solitary.length ? ` (${solitary.map((s) => `#${s.node.prNumber}: ${s.reason}`).join("; ")})` : "";
        console.log(`no chain of two or more PRs to link for ${branch}${detail}`);
        return;
      }

      const results = linkStacks({ repoRoot, chains, dryRun: flags.dryRun });
      if (flags.json) console.log(JSON.stringify(stackLinksToJson(results)));
      else printStackLinks(results, flags.dryRun);

      // A chain drip couldn't group is not a failure of the run — the PRs are
      // fine, they just aren't a stack — but it's the reason someone would go
      // looking, so it exits non-zero rather than being buried in the report.
      if (results.some((r) => r.status === "diverged")) process.exit(1);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch whose PRs to link", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      json: jsonFlag,
      yes: { kind: "boolean", brief: "confirm: this creates a real stack on GitHub", default: false },
      dryRun: { kind: "boolean", brief: "preview the chains without reading or writing GitHub", default: false },
    },
  },
  docs: { brief: "group drip's PRs into a stack on GitHub" },
});

export const stackRoutes = buildRouteMap({
  routes: { status: statusCommand, link: linkCommand },
  docs: { brief: "GitHub stacks over drip's projections" },
});
