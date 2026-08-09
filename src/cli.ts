#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  adoptionToJson,
  checkAdoption,
  fetchAdoptedHead,
  listProjectionCorrespondence,
  printAdoptionReport,
  recordAdoption,
} from "./adopt";
import { assignChangeIds } from "./change-id";
import { computeProjections, printProjections, projectionsToJson } from "./coarsen";
import {
  emitManifest,
  findManifest,
  loadManifest,
  manifestCandidates,
  manifestReportToJson,
  manifestSignature,
  printManifestReport,
  resolveManifest,
  unitsFromManifest,
  validateManifestAgainstGit,
  verificationUnits,
  writeManifest,
  type Finding,
} from "./manifest";
import { materializeProjections, materializeToJson, printMaterializeReport } from "./materialize-local";
import { DripError } from "./errors";
import { ShellGitBackend, type GitBackend } from "./git-backend";
import { ghPrView } from "./github";
import { planToJson, printPlan, type PlanResult } from "./planner";
import { push, type PushUnits } from "./push";
import { resolveRepoRoot } from "./repo";
import { describeSource, sourceToJson } from "./source";
import { addOverride, deleteCorrespondence, listOverrides, openStore, recordTiming, removeOverride } from "./store";
import type { VerificationRun } from "./verification";
import { loadPlan, runVerify } from "./workflow";

function usage(): never {
  console.error(
    "usage: drip plan <branch>|--worktree [--repo path] [--base branch] [--timing] [--assign-ids] [--json] [--coarsen] [--target-slices n] [--emit-manifest [--manifest path] [--force]]",
  );
  console.error("       drip verify <branch>|--worktree [--repo path] [--base branch] [--timing] [--coarsen] [--target-slices n] [--build-cmd cmd] [--no-build-check]");
  console.error("       drip validate-plan <branch> [--manifest path] [--repo path] [--base branch] [--json] [--no-manifest-check] [--strict]");
  console.error(
    "       drip materialize <branch> [--manifest path] [--repo path] [--base branch] [--projection flat-first|stacked] [--only id[,id]] [--output dir] [--force] [--json] [--no-manifest-check] [--strict]",
  );
  console.error(
    "       drip push <branch> [--repo path] [--base branch] [--projection stacked|flat-first] [--manifest path] [--no-manifest-check] [--strict] [--draft] [--build-cmd cmd] [--no-build-check] --yes | --dry-run",
  );
  console.error(
    "       drip override add <branch> --kind force_merge|force_split --selector-a file::Symbol [--selector-b file::Symbol] [--note text] [--repo path]",
  );
  console.error("       drip override list <branch> [--repo path]");
  console.error("       drip override remove <id> [--repo path]");
  console.error(
    "       drip manifest adopt <branch> --projection id --pr n --head branch [--manifest path] [--repo path] [--base branch] [--remote name] [--json] [--yes]",
  );
  console.error("       drip manifest list <branch> [--repo path]");
  console.error("       drip manifest forget <branch> --projection id [--repo path]");
  console.error("       drip mcp   (starts an MCP stdio server exposing plan/verify/override as tools)");
  process.exit(2);
}

function reportTiming(
  db: ReturnType<typeof openStore>,
  branch: string,
  command: "plan" | "verify",
  hunkCount: number,
  sliceCount: number,
  durationMs: number,
) {
  recordTiming(db, branch, command, hunkCount, sliceCount, durationMs);
  console.log(`\nTIMING: ${command} took ${durationMs}ms (${hunkCount} hunks, ${sliceCount} slices)`);
}

// Formats runVerify's structured result as the CLI's text output. Shared by
// `verify` and `push` — push must never skip verification, per the plan's
// own M2 scope ("refuses to push if verify fails").
function printVerifyResult(result: Awaited<ReturnType<typeof runVerify>>, sliceCount: number): void {
  console.log(`\n${result.tree.message}`);

  const { build } = result;
  if (build.kind === "disabled") return;
  if (build.kind === "no-command") {
    console.log("BUILD CHECK: skipped (no tsconfig.json found — use --build-cmd to specify one)");
    return;
  }

  const skipNote = build.result.skipped ? `, ${build.result.skipped} cached` : "";
  if (build.result.failures.length) {
    console.log(`BUILD CHECK: FAIL (\`${build.buildCmd}\`${skipNote})`);
    for (const f of build.result.failures) {
      const lines = f.output.split("\n").filter((l) => l.trim().length > 0);
      const shown = lines.slice(0, 8);
      console.log(`  ${f.slice}:`);
      for (const line of shown) console.log(`    ${line}`);
      if (lines.length > shown.length) console.log(`    ... (${lines.length - shown.length} more lines)`);
    }
  } else {
    console.log(`BUILD CHECK: PASS (\`${build.buildCmd}\`, ${sliceCount} slices${skipNote})`);
  }
}

// --strict promotes every manifest warning to a failure. Useful in CI, where
// "declares no verification commands" or "uses an ordinal selector" are things
// you want to block on rather than read past.
function manifestFailed(resolved: { findings: { severity: string }[] }, extra: { severity: string }[], strict: boolean): boolean {
  const all = [...resolved.findings, ...extra];
  return all.some((f) => f.severity === "error" || (strict && f.severity === "warning"));
}

async function runOverrideCommand(git: GitBackend, positionals: string[], values: Record<string, unknown>) {
  const [, sub, arg] = positionals;
  const targetDir = (values.repo as string | undefined) ?? process.cwd();
  const repoRoot = resolveRepoRoot(git, targetDir);
  const db = openStore(repoRoot);

  if (sub === "add") {
    const branch = arg;
    if (!branch) throw new DripError("override add requires a branch: drip override add <branch> --kind ... --selector-a ...");
    const kind = (values.kind as string | undefined) ?? "";
    const selectorA = values["selector-a"] as string | undefined;
    if (!selectorA) throw new DripError("--selector-a is required (format: file::QualifiedSymbolPath)");
    const selectorB = (values["selector-b"] as string | undefined) ?? null;
    // addOverride validates kind/selector format/selectorB presence rules and
    // throws DripError — one place, not duplicated per caller.
    addOverride(db, branch, kind, selectorA, selectorB, (values.note as string) ?? null);
    console.log(`added ${kind} override for ${branch}`);
    return;
  }

  if (sub === "list") {
    const branch = arg;
    if (!branch) throw new DripError("override list requires a branch: drip override list <branch>");
    const overrides = listOverrides(db, branch);
    if (!overrides.length) {
      console.log(`no overrides for ${branch}`);
      return;
    }
    for (const o of overrides) {
      const pair = o.kind === "force_merge" ? `${o.selectorA} <-> ${o.selectorB}` : o.selectorA;
      console.log(`  [${o.id}] ${o.kind}: ${pair}${o.note ? `  (${o.note})` : ""}`);
    }
    return;
  }

  if (sub === "remove") {
    const idStr = arg;
    const id = Number(idStr);
    if (!idStr || !Number.isInteger(id)) throw new DripError("override remove requires a numeric id: drip override remove <id>");
    const removed = removeOverride(db, id);
    console.log(removed ? `removed override ${id}` : `no override with id ${id}`);
    return;
  }

  usage();
}

// Resolves the manifest for a command that reads one: an explicit --manifest,
// else the conventional location. Same rule as validate-plan — discovery is
// for reading, never for deciding what `push --yes` sends to GitHub.
function resolveManifestPath(repoRoot: string, branch: string, explicit: string | undefined, quiet: boolean): string {
  const path = explicit ?? findManifest(repoRoot, branch);
  if (!path) {
    throw new DripError(
      `no manifest found for '${branch}' — pass --manifest <path>, or create one at ${manifestCandidates(repoRoot, branch)[0]} ` +
        `(\`drip plan ${branch} --coarsen --emit-manifest\` writes a starting point)`,
    );
  }
  if (!explicit && !quiet) console.log(`using ${path}\n`);
  return path;
}

// Resolve a manifest against the plan and run the git-backed checks — the step
// `validate-plan`, `materialize` and `push --manifest` all share. The git
// checks only run once the manifest is structurally coherent; on a broken graph
// they just produce noise blaming the same upstream cause repeatedly.
async function checkManifest(opts: {
  git: GitBackend;
  repoRoot: string;
  branch: string;
  mergeBase: string;
  plan: PlanResult;
  db: ReturnType<typeof openStore>;
  manifestPath: string;
  runVerification: boolean;
  /** what the projections must reconstruct — the working tree under --worktree */
  sourceRef?: string;
}) {
  const { git, repoRoot, branch, mergeBase, plan, db, sourceRef } = opts;
  const resolved = resolveManifest(plan, loadManifest(opts.manifestPath), { branch });
  const checked = resolved.ok
    ? await validateManifestAgainstGit({ git, repoRoot, branch, mergeBase, plan, resolved, db, sourceRef, runVerification: opts.runVerification })
    : { findings: [] as Finding[], verification: [] as VerificationRun[] };
  return { resolved, checked };
}

// `drip manifest adopt|list|forget` — binding a semantic projection to a PR
// that already exists, rather than opening a new one. See docs/adr/0020.
async function runManifestCommand(git: GitBackend, positionals: string[], values: Record<string, unknown>) {
  const [, sub, branch] = positionals;
  if (sub !== "adopt" && sub !== "list" && sub !== "forget") usage();
  if (!branch) throw new DripError(`drip manifest ${sub} requires the mega branch: drip manifest ${sub} <branch> ...`);

  const repoRoot = resolveRepoRoot(git, (values.repo as string | undefined) ?? process.cwd());

  if (sub === "list") {
    const rows = listProjectionCorrespondence(openStore(repoRoot), branch);
    if (!rows.length) {
      console.log(`no projection PRs recorded for ${branch}`);
      return;
    }
    console.log(`PROJECTION PRs (${branch}):`);
    for (const r of rows) {
      console.log(`  ${r.projectionId} -> ${r.branch}${r.prNumber ? ` #${r.prNumber}` : ""} [${r.adopted ? "adopted" : "drip"}] base: ${r.baseRef ?? "?"}${r.prUrl ? ` ${r.prUrl}` : ""}`);
    }
    return;
  }

  const projectionId = values.projection as string | undefined;
  if (!projectionId) throw new DripError(`drip manifest ${sub} requires --projection <id> — the semantic projection this PR corresponds to`);

  if (sub === "forget") {
    deleteCorrespondence(openStore(repoRoot), branch, manifestSignature(projectionId));
    console.log(`forgot the correspondence for '${projectionId}' on ${branch} — the PR and its branch are untouched`);
    return;
  }

  // --- adopt ----------------------------------------------------------------
  const prNumber = Number(values.pr);
  if (values.pr === undefined || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new DripError("--pr must be the existing pull request's number");
  }
  const head = values.head as string | undefined;
  if (!head) throw new DripError("--head must name the branch the PR is on — adoption never infers which branch belongs to a projection");

  const baseBranch = values.base as string;
  const jsonOut = !!values.json;
  const { db, mergeBase, plan } = await loadPlan({ git, repoRoot, branch, baseBranch });
  if (!plan.hunks.length) throw new DripError(`no changes between ${baseBranch} and ${branch} — there is no projection to adopt a PR into`);
  if (!plan.order) {
    if (!jsonOut) printPlan(plan);
    throw new DripError("cannot adopt against a cyclic slice DAG — resolve the cycle first");
  }

  const resolved = resolveManifest(plan, loadManifest(resolveManifestPath(repoRoot, branch, values.manifest as string | undefined, jsonOut)), { branch });
  if (!resolved.ok) {
    // Adoption binds a real PR to a projection, so the manifest that defines
    // that projection has to hold together first — otherwise the thing being
    // bound isn't well-defined.
    if (!jsonOut) printManifestReport(resolved);
    throw new DripError("manifest validation failed — fix it before binding a PR to one of its projections");
  }
  if (!resolved.projections.some((p) => p.id === projectionId)) {
    throw new DripError(`no projection '${projectionId}' in this manifest — known ids: ${resolved.projections.map((p) => p.id).join(", ")}`);
  }

  const check = await checkAdoption({
    git,
    db,
    repoRoot,
    branch,
    baseBranch,
    mergeBase,
    plan,
    resolved,
    projectionId,
    head,
    headSha: fetchAdoptedHead(git, repoRoot, (values.remote as string | undefined) ?? "origin", head),
    pr: ghPrView(repoRoot, prNumber),
  });

  if (jsonOut) console.log(JSON.stringify(adoptionToJson(check)));
  else printAdoptionReport(check);
  if (!check.ok) process.exit(1);

  // The check is read-only; recording the correspondence is what makes a later
  // `push --manifest` treat someone else's branch as this projection's own.
  if (!values.yes) {
    if (!jsonOut) console.log("\nnot recorded: re-run with --yes to bind this projection to the PR.");
    return;
  }
  recordAdoption(db, branch, check);
  if (!jsonOut) console.log(`\nadopted: '${projectionId}' now corresponds to #${check.pr.number} on ${check.head} — nothing was pushed.`);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      base: { type: "string", default: "main" },
      timing: { type: "boolean", default: false },
      "assign-ids": { type: "boolean", default: false },
      "build-cmd": { type: "string" },
      "no-build-check": { type: "boolean", default: false },
      // On `push` and `materialize` this is the base-selection mode — default
      // "stacked" there, "flat-first" here (docs/adr/0022); on `manifest adopt`
      // it names the projection being bound. No default, so adopt can tell
      // "not given" from "given".
      projection: { type: "string" },
      pr: { type: "string" },
      head: { type: "string" },
      remote: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      draft: { type: "boolean", default: false },
      // `materialize` only: which projections to write, and where to check
      // them out. Repeatable and comma-separated both work.
      only: { type: "string", multiple: true },
      output: { type: "string" },
      json: { type: "boolean", default: false },
      coarsen: { type: "boolean", default: false },
      worktree: { type: "boolean", default: false },
      "target-slices": { type: "string" },
      manifest: { type: "string" },
      "no-manifest-check": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      "emit-manifest": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      kind: { type: "string" },
      "selector-a": { type: "string" },
      "selector-b": { type: "string" },
      note: { type: "string" },
    },
  });

  const [command, branchArg] = positionals;

  if (command === "mcp") {
    await import("./mcp");
    return;
  }

  const git = new ShellGitBackend();

  if (command === "override") {
    await runOverrideCommand(git, positionals, values);
    return;
  }

  if (command === "manifest") {
    await runManifestCommand(git, positionals, values);
    return;
  }

  const isCommand =
    command === "plan" || command === "verify" || command === "push" || command === "validate-plan" || command === "materialize";
  const worktree = !!values.worktree;
  if (!command || !isCommand || (!branchArg && !worktree)) usage();

  const targetDir = values.repo ?? process.cwd();
  const repoRoot = resolveRepoRoot(git, targetDir);
  const baseBranch = values.base!;
  const started = Date.now();

  const jsonOut = !!values.json && (command === "plan" || command === "validate-plan" || command === "materialize");

  // Worktree mode is a *planning* source: it describes work that isn't
  // committed yet, so anything that rewrites history or publishes to GitHub
  // has nothing coherent to act on. Both refuse rather than half-work.
  if (worktree && values["assign-ids"]) {
    throw new DripError("--assign-ids rewrites commits, so it can't run against a working tree — commit first, then assign ids");
  }
  if (worktree && command === "push") {
    throw new DripError(
      "push opens real PRs, and --worktree's content exists only in your working tree — commit the slices first. " +
        "The manifest's selectors are durable, so a plan made with --worktree still validates once the commits exist.",
    );
  }

  if (command === "plan" && values["assign-ids"]) {
    const { rewritten, headSha } = assignChangeIds(git, repoRoot, branchArg!, baseBranch);
    if (!jsonOut) {
      if (rewritten.length) {
        console.log(`Assigned Change-Id trailers, rewrote ${rewritten.length} commit(s):`);
        for (const r of rewritten) console.log(`  ${r.old.slice(0, 7)} -> ${r.new.slice(0, 7)}`);
        console.log(`${branchArg} now points at ${headSha.slice(0, 7)}\n`);
      } else {
        console.log("All commits already have Change-Id trailers.\n");
      }
    }
  }

  const { db, mergeBase, plan, source } = await loadPlan({ git, repoRoot, branch: branchArg, baseBranch, worktree });
  // From here on the plan's identity is the branch it belongs to, which in
  // worktree mode is the checked-out branch rather than a positional.
  const branch = source.label;
  if (!jsonOut) console.log(`${describeSource(source)}\n`);

  if (plan.hunks.length === 0) {
    if (jsonOut) console.log(JSON.stringify({ ok: true, slices: [], edges: [], unmatchedOverrideSelectors: [], excluded: plan.excluded, source: sourceToJson(source) }));
    else console.log(`No changes between ${baseBranch} and ${branch} — nothing to slice.`);
    return;
  }

  // --- validate-plan / materialize: manifest commands with no remote effects ---
  // Both read the manifest, so discovering the conventional location is safe
  // and saves typing the same path every run — unlike `push`, where discovery
  // would decide what gets sent to GitHub.
  if (command === "validate-plan" || command === "materialize") {
    const manifestPath = resolveManifestPath(repoRoot, branch, values.manifest, jsonOut);
    if (!plan.order) {
      printPlan(plan);
      throw new DripError(`cannot ${command === "materialize" ? "materialize" : "validate"} against a cyclic slice DAG — resolve the cycle first`);
    }
    const { resolved, checked } = await checkManifest({
      git,
      repoRoot,
      branch,
      mergeBase,
      plan,
      db,
      manifestPath,
      sourceRef: source.ref,
      runVerification: !values["no-manifest-check"],
    });
    const failed = manifestFailed(resolved, checked.findings, !!values.strict);

    if (command === "validate-plan") {
      if (jsonOut) console.log(JSON.stringify(manifestReportToJson(resolved, checked.findings, checked.verification)));
      else printManifestReport(resolved, checked.findings, checked.verification, !!values.strict);
      if (failed) process.exit(1);
      return;
    }

    // Materializing a manifest that doesn't hold together would produce refs
    // for projections drip has just said are wrong.
    const manifestJson = manifestReportToJson(resolved, checked.findings, checked.verification);
    if (failed) {
      if (jsonOut) console.log(JSON.stringify({ ok: false, manifest: manifestJson, materialize: null }));
      else {
        printManifestReport(resolved, checked.findings, checked.verification, !!values.strict);
        console.error("\nmaterialize refused: manifest validation failed");
      }
      process.exit(1);
    }
    if (!jsonOut) {
      printManifestReport(resolved, checked.findings, checked.verification, !!values.strict);
      console.log("");
    }

    // Flat-first by default, unlike `push`: a manifest's dependsOn graph *is*
    // the flat-first base selection, and it's what validation and `manifest
    // adopt` both materialize. Stacked stays available for previewing what
    // `push` (whose own default is stacked) would send.
    const mode = values.projection ?? "flat-first";
    if (mode !== "stacked" && mode !== "flat-first") {
      throw new DripError(`--projection must be 'stacked' or 'flat-first', got '${mode}'`);
    }
    const only = ((values.only as string[] | undefined) ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);

    const result = await materializeProjections({
      git,
      db,
      repoRoot,
      branch,
      baseBranch,
      mergeBase,
      plan,
      resolved,
      mode,
      only,
      outputDir: values.output ?? null,
      force: !!values.force,
    });
    if (jsonOut) console.log(JSON.stringify({ ok: result.ok, manifest: manifestJson, materialize: materializeToJson(result) }));
    else printMaterializeReport(result);
    if (!result.ok) process.exit(1);
    return;
  }

  // Coarsening needs an acyclic DAG, so it can only run after the plan is
  // known good — the cycle report below still comes out either way.
  const wantCoarsen = !!values.coarsen;
  const targetSlices = values["target-slices"] === undefined ? undefined : Number(values["target-slices"]);
  if (targetSlices !== undefined && !Number.isInteger(targetSlices)) {
    throw new DripError(`--target-slices must be a whole number, got '${values["target-slices"]}'`);
  }

  if (!jsonOut) printPlan(plan);

  if (!plan.order) {
    if (jsonOut) console.log(JSON.stringify({ ...planToJson(plan), source: sourceToJson(source) }));
    process.exit(1);
  }

  const coarse = wantCoarsen ? computeProjections(plan, { targetSlices }) : null;
  if (jsonOut) console.log(JSON.stringify({ ...planToJson(plan), ...(coarse ? projectionsToJson(coarse) : {}), source: sourceToJson(source) }));
  else if (coarse) printProjections(coarse);

  if (values["emit-manifest"]) {
    if (!coarse) throw new DripError("--emit-manifest needs --coarsen: the emitted skeleton is built from the coarsened projections");
    // `--manifest` names the destination here; on every other command it names
    // the input. Same flag, same meaning — "the manifest file for this run".
    const out = values.manifest ?? manifestCandidates(repoRoot, branch)[0]!;
    writeManifest(out, emitManifest(coarse, plan, { branch, base: baseBranch }), { force: !!values.force });
    console.log(`\nwrote ${out} — a starting point, not a plan: give each projection a real id, title and intent before using it.`);
  }

  if (command === "plan") {
    if (values.timing && !jsonOut) reportTiming(db, branch, "plan", plan.hunks.length, plan.slices.size, Date.now() - started);
    return;
  }

  // `push` materializes atomic slices; verifying a coarsened projection here
  // would prove something other than what gets pushed.
  if (coarse && command === "push") {
    throw new DripError("--coarsen is a planning mode — `drip push` materializes atomic slices. Use `drip plan --coarsen` / `drip verify --coarsen`.");
  }

  // A manifest defines the units `push` materializes, so verification must run
  // against those same units — verifying atomic slices and pushing projections
  // would prove the wrong thing. Validated first: pushing an incoherent
  // manifest is worse than not pushing at all.
  let manifestUnits: PushUnits | undefined;
  let manifestVerifyUnits: ReturnType<typeof verificationUnits> | undefined;
  // Unlike validate-plan, push does *not* auto-discover. A manifest left lying
  // around must never silently change what a `push --yes` sends to GitHub —
  // but staying quiet about one would be its own trap, so say it's there.
  if (!values.manifest && command === "push") {
    const found = findManifest(repoRoot, branch);
    if (found) console.log(`\nnote: a manifest exists at ${found}, but --manifest was not passed — pushing atomic slices.`);
  }
  if (values.manifest) {
    const { resolved, checked } = await checkManifest({
      git,
      repoRoot,
      branch,
      mergeBase,
      plan,
      db,
      manifestPath: values.manifest,
      sourceRef: source.ref,
      runVerification: !values["no-manifest-check"],
    });
    printManifestReport(resolved, checked.findings, checked.verification, !!values.strict);
    if (manifestFailed(resolved, checked.findings, !!values.strict)) {
      console.error("\npush refused: manifest validation failed");
      process.exit(1);
    }
    manifestUnits = unitsFromManifest(resolved, branch);
    // Verification covers the deferred remainder too, so the tree check proves
    // nothing was lost; push still only materializes the projections.
    manifestVerifyUnits = verificationUnits(resolved);
  }

  const verifyResult = await runVerify({
    git,
    db,
    branch,
    repoRoot,
    mergeBase,
    plan,
    buildCmdOverride: values["build-cmd"],
    noBuildCheck: !!values["no-build-check"],
    coarsen: coarse,
    units: manifestVerifyUnits,
    sourceRef: source.ref,
  });
  printVerifyResult(verifyResult, manifestUnits ? manifestUnits.order.length : coarse ? coarse.projections.length : plan.order.length);
  const pass = verifyResult.pass;

  if (command === "verify") {
    if (values.timing) reportTiming(db, branch, "verify", plan.hunks.length, plan.slices.size, Date.now() - started);
    if (!pass) process.exit(1);
    return;
  }

  // push
  if (!pass) {
    console.error("\npush refused: verify failed");
    process.exit(1);
  }

  const dryRun = !!values["dry-run"];
  if (!dryRun && !values.yes) {
    throw new DripError("push creates real branches and opens real PRs on GitHub — pass --yes to confirm, or --dry-run to preview first");
  }

  const projection = values.projection ?? "stacked";
  if (projection !== "stacked" && projection !== "flat-first") {
    throw new DripError(`--projection must be 'stacked' or 'flat-first', got '${projection}'`);
  }

  const draft = !!values.draft;
  const results = await push({ git, db, repoRoot, branch, baseBranch, mergeBase, plan, dryRun, projection, units: manifestUnits, draft });
  const mode = `${projection}${manifestUnits ? ", manifest" : ""}${draft ? ", draft" : ""}`;
  console.log(dryRun ? `\nDRY RUN (${mode}, no branches pushed, no PRs created):` : `\nPUSHED (${mode}):`);
  for (const r of results) {
    // The draft state is only ever printed for a PR this run opens, so a
    // dry-run says "would open a draft" and a re-run over an existing PR
    // says nothing rather than implying it changed anything.
    const state = r.draft === null ? "" : r.draft ? " (draft)" : " (ready for review)";
    console.log(`  ${r.sliceLabel} -> ${r.branchName} [${r.status}]${state} base: ${r.base}${r.prUrl ? ` ${r.prUrl}` : ""}`);
    if (r.note) console.log(`      ${r.note}`);
  }
  const blocked = results.filter((r) => r.status === "blocked");
  if (blocked.length) {
    console.error(`\n${blocked.length} slice(s) blocked — not pushed. See the notes above.`);
    process.exit(1);
  }
}

main().catch((e) => {
  if (e instanceof DripError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
});
