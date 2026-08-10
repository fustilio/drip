import { buildCommand } from "@stricli/core";
import { DripError } from "../errors";
import { findManifest, printManifestReport, unitsFromManifest, verificationUnits } from "../manifest";
import { push, type PushUnits } from "../push";
import { linearChains, linkStacks, printStackLinks } from "../stacks";
import { runVerify } from "../workflow";
import {
  baseFlag,
  buildCheckFlags,
  checkManifest,
  command,
  git,
  manifestCheckFlags,
  manifestFailed,
  openPlanContext,
  printPlanOrExit,
  printVerifyResult,
  repoFlag,
} from "./shared";

type PushFlags = {
  repo?: string;
  base: string;
  projection: "stacked" | "flat-first";
  manifest?: string;
  noManifestCheck: boolean;
  strict: boolean;
  requireVerification: boolean;
  requireIntent: boolean;
  reviewableStack: boolean;
  linkStack: boolean;
  draft: boolean;
  reclaim: boolean;
  buildCmd?: string;
  noBuildCheck: boolean;
  yes: boolean;
  dryRun: boolean;
};

export const pushCommand = buildCommand({
  loader: async () =>
    command(async (flags: PushFlags, branch: string) => {
      // No --worktree here: push opens real PRs, and a working tree's content
      // exists only locally. The refusal used to live in the shared arg
      // handling; now the flag simply isn't declared on this command, so
      // `push --worktree` is rejected by the parser with the reason in --help.
      const ctx = await openPlanContext({ repo: flags.repo, base: flags.base, branch });
      if (!ctx) return;

      const order = printPlanOrExit(ctx);

      // A manifest defines the units `push` materializes, so verification must
      // run against those same units — verifying atomic slices and pushing
      // projections would prove the wrong thing.
      let manifestUnits: PushUnits | undefined;
      let manifestVerifyUnits: ReturnType<typeof verificationUnits> | undefined;

      // Unlike validate-plan, push does *not* auto-discover. A manifest left
      // lying around must never silently change what a `push --yes` sends to
      // GitHub — but staying quiet about one would be its own trap.
      if (!flags.manifest) {
        const found = findManifest(ctx.repoRoot, ctx.branch);
        if (found) console.log(`\nnote: a manifest exists at ${found}, but --manifest was not passed — pushing atomic slices.`);
      } else {
        const { resolved, checked } = await checkManifest({
          repoRoot: ctx.repoRoot,
          branch: ctx.branch,
          mergeBase: ctx.mergeBase,
          plan: ctx.plan,
          db: ctx.db,
          manifestPath: flags.manifest,
          sourceRef: ctx.source.ref,
          runVerification: !flags.noManifestCheck,
          requireVerification: flags.requireVerification,
          requireIntent: flags.requireIntent,
        });
        printManifestReport(resolved, checked.findings, checked.verification, flags.strict);
        if (manifestFailed(resolved, checked.findings, flags.strict)) {
          console.error("\npush refused: manifest validation failed");
          process.exit(1);
        }
        manifestUnits = unitsFromManifest(resolved, ctx.branch);
        // Verification covers the deferred remainder too, so the tree check
        // proves nothing was lost; push still only materializes the projections.
        manifestVerifyUnits = verificationUnits(resolved);
      }

      const verifyResult = await runVerify({
        git,
        db: ctx.db,
        branch: ctx.branch,
        repoRoot: ctx.repoRoot,
        mergeBase: ctx.mergeBase,
        plan: ctx.plan,
        buildCmdOverride: flags.buildCmd,
        noBuildCheck: flags.noBuildCheck,
        coarsen: null,
        units: manifestVerifyUnits,
        sourceRef: ctx.source.ref,
      });
      printVerifyResult(verifyResult, manifestUnits ? manifestUnits.order.length : order.length);
      if (!verifyResult.pass) {
        console.error("\npush refused: verify failed");
        process.exit(1);
      }

      if (!flags.dryRun && !flags.yes) {
        throw new DripError("push creates real branches and opens real PRs on GitHub — pass --yes to confirm, or --dry-run to preview first");
      }

      const results = await push({
        git,
        db: ctx.db,
        repoRoot: ctx.repoRoot,
        branch: ctx.branch,
        baseBranch: ctx.baseBranch,
        mergeBase: ctx.mergeBase,
        plan: ctx.plan,
        dryRun: flags.dryRun,
        projection: flags.projection,
        units: manifestUnits,
        draft: flags.draft,
        reviewableStack: flags.reviewableStack,
        reclaim: flags.reclaim,
      });

      const mode = [
        flags.projection,
        manifestUnits ? "manifest" : null,
        flags.draft ? "draft" : null,
        flags.reviewableStack ? "reviewable-stack" : null,
        flags.linkStack ? "link-stack" : null,
        flags.reclaim ? "reclaim" : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(flags.dryRun ? `\nDRY RUN (${mode}, no branches pushed, no PRs created):` : `\nPUSHED (${mode}):`);
      for (const r of results) {
        // The draft state is only ever printed for a PR this run opens, so a
        // dry-run says "would open a draft" and a re-run over an existing PR
        // says nothing rather than implying it changed anything.
        const state = r.draft === null ? "" : r.draft ? " (draft)" : " (ready for review)";
        const base = r.hiddenBase ? `${r.base} (generated, not reviewable on GitHub)` : r.base;
        console.log(`  ${r.sliceLabel} -> ${r.branchName} [${r.status}]${state} base: ${base}${r.prUrl ? ` ${r.prUrl}` : ""}`);
        if (r.note) console.log(`      ${r.note}`);
      }

      // A generated integration base merges fine and reviews terribly, so it is
      // called out as a group rather than left to be spotted per line (issue #14).
      const hidden = results.filter((r) => r.hiddenBase);
      if (hidden.length) {
        console.log(
          `\n${hidden.length} PR(s) target a generated integration base with no PR of its own: ${hidden.map((r) => r.base).join(", ")}.\n` +
            "  Reviewers can't walk those prerequisites as a stack, and a workflow filtered on the base branch (e.g. `pull_request.branches: [main]`)\n" +
            "  won't run CI on them. Re-run with --reviewable-stack to refuse instead, then merge those prerequisites into one projection or\n" +
            "  declare a projection that depends on them.",
        );
      }

      // The PR chain this push just produced, as GitHub's stack model sees it:
      // derived from the bases actually set, so a chain reported here is one
      // GitHub would accept (docs/adr/0030). Reported whether or not --link-stack
      // was passed — a stack drip could have made and didn't is exactly the kind
      // of thing that should never be discovered later.
      const { chains, solitary } = linearChains(
        results
          .filter((r) => r.prNumber && (r.status === "created" || r.status === "updated" || r.status === "unchanged" || r.status === "dry-run"))
          .map((r) => ({ id: r.sliceLabel, branch: r.branchName, prNumber: r.prNumber!, base: r.base })),
      );

      if (!chains.length) {
        if (solitary.length > 1) {
          console.log(
            `\nNo GitHub stack: these PRs don't chain (${solitary.map((s) => `${s.node.id} — ${s.reason}`).join("; ")}).\n` +
              "  A stack is a linear run of PRs, each based on the one below it. `--projection stacked` produces one by construction.",
          );
        }
      } else if (flags.linkStack) {
        printStackLinks(linkStacks({ repoRoot: ctx.repoRoot, chains, dryRun: flags.dryRun }), flags.dryRun);
      } else {
        console.log(
          `\n${chains.length} PR chain(s) could be grouped as a GitHub stack — reviewers walk the layers in the PR UI and\n` +
            "  `gh stack merge` lands a prefix of the chain atomically. Nothing was grouped: re-run with --link-stack, or\n" +
            `  run \`drip stack link ${ctx.branch} --yes\` on its own.`,
        );
        for (const chain of chains) {
          console.log(`    on ${chain.base}: ${chain.members.map((m) => `${m.id}(#${m.prNumber})`).join(" <- ")}`);
        }
      }

      const blocked = results.filter((r) => r.status === "blocked");
      if (blocked.length) {
        console.error(`\n${blocked.length} slice(s) blocked — not pushed. See the notes above.`);
        process.exit(1);
      }
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch to push slices of", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      base: baseFlag,
      projection: {
        kind: "enum",
        values: ["stacked", "flat-first"],
        brief: "how each PR's base is chosen",
        default: "stacked",
      },
      manifest: { kind: "parsed", parse: String, brief: "push a manifest's projections instead of atomic slices", optional: true },
      ...manifestCheckFlags,
      reviewableStack: { kind: "boolean", brief: "refuse any projection needing a generated integration base", default: false },
      linkStack: { kind: "boolean", brief: "group the resulting PR chain into a stack on GitHub", default: false },
      draft: { kind: "boolean", brief: "open drip-owned PRs as drafts", default: false },
      reclaim: { kind: "boolean", brief: "overwrite a drip-owned branch that has moved on the remote", default: false },
      ...buildCheckFlags,
      yes: { kind: "boolean", brief: "confirm: this opens real PRs on GitHub", default: false },
      dryRun: { kind: "boolean", brief: "preview without touching GitHub", default: false },
    },
  },
  docs: { brief: "materialize slices as branches and open a PR for each" },
});
