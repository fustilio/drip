import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { DripError } from "./errors";
import type { GitBackend } from "./git-backend";
import type { PrRef } from "./github";
import { manifestSignature, type Finding, type ResolvedManifest } from "./manifest";
import { buildSlicePatch, materializeFlatFirst } from "./materialize";
import type { PlanResult } from "./planner";
import { dripBranchName } from "./push";
import { computeContentHash } from "./signature";
import { getCorrespondence, listCorrespondence, upsertCorrespondence } from "./store";

// Adopting a pre-existing PR into a semantic projection (issue #11).
//
// `push --manifest` maintains correspondence for PRs drip opened. Real teams
// usually arrive the other way round: several good, small, handcrafted PRs
// already exist — with reviewers, comments, approvals and branch names worth
// more than drip's ability to recreate them — and only later does an
// integration branch expose their combined dependency graph and motivate a
// manifest. Without adoption the choice is between abandoning that review
// context and not using drip for the integration workflow at all.
//
// So adoption is explicit and evidence-based. The caller names the projection,
// the PR number and the head branch; drip binds them only after proving the
// branch's own content is exactly what that projection materializes. Nothing
// is inferred from titles or similarity — a wrong guess here would eventually
// force-push a projection over an unrelated team's branch — and nothing is
// pushed during adoption itself: the branch keeps its history until a later
// `push --manifest` genuinely has different content to send.

export type AdoptionCheck = {
  projectionId: string;
  pr: PrRef;
  head: string;
  headSha: string;
  /** the base flat-first would pick for this projection from the manifest graph */
  manifestBase: string;
  baseAgrees: boolean;
  /** prerequisite projection ids whose content this branch must therefore also carry */
  prerequisites: string[];
  /** the projection's materialized commit — what a later push would send */
  commit: string | null;
  contentHash: string | null;
  /** projection tree → adopted branch content, when the two differ */
  interdiff: string | null;
  findings: Finding[];
  ok: boolean;
};

/** How much interdiff to carry back for the report. A whole diverged branch is not a diagnostic. */
const INTERDIFF_LIMIT = 20000;

// The branch a projection's PR lives on: the adopted one when there is a
// correspondence, else the name push would mint for it.
export function projectionBranch(db: Database, branch: string, projectionId: string): string {
  return getCorrespondence(db, branch, manifestSignature(projectionId))?.sliceBranch ?? dripBranchName(branch, projectionId);
}

// The adopted branch lives on the remote — that's the premise of the whole
// command — so it's fetched by name rather than read from a local ref that may
// be absent in a fresh clone or stale in an old one.
export function fetchAdoptedHead(git: GitBackend, repoRoot: string, remote: string, head: string): string {
  try {
    git.fetch(remote, head, repoRoot);
  } catch (e: any) {
    throw new DripError(`could not fetch '${head}' from ${remote}: ${String(e.stderr ?? e.message ?? e).trim()}`);
  }
  return git.revParse("FETCH_HEAD", repoRoot);
}

export async function checkAdoption(opts: {
  git: GitBackend;
  db: Database;
  repoRoot: string;
  /** the mega branch this manifest projects */
  branch: string;
  baseBranch: string;
  mergeBase: string;
  plan: PlanResult;
  resolved: ResolvedManifest;
  projectionId: string;
  head: string;
  headSha: string;
  pr: PrRef;
}): Promise<AdoptionCheck> {
  const { git, db, repoRoot, branch, baseBranch, mergeBase, plan, resolved, projectionId, head, headSha, pr } = opts;
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], code: Finding["code"], message: string) =>
    findings.push({ severity, code, projection: projectionId, message });

  // --- the PR is what the caller says it is ---------------------------------
  // All three of projection id, PR number and branch name are required and
  // cross-checked. Adoption on two out of three would be a heuristic.
  if (pr.state !== "OPEN") {
    add("error", "adopt-pr-state", `PR #${pr.number} is ${pr.state}, not OPEN — there is no live review surface to adopt`);
  }
  if (pr.headRefName && pr.headRefName !== head) {
    add("error", "adopt-head-mismatch", `PR #${pr.number} is on branch '${pr.headRefName}', not '${head}' — refusing to adopt a PR the caller has mis-identified`);
  }
  for (const other of listCorrespondence(db, branch)) {
    if (other.sliceSignature === manifestSignature(projectionId)) continue;
    if (other.sliceBranch !== head && other.prNumber !== pr.number) continue;
    add(
      "error",
      "adopt-conflict",
      `${other.sliceBranch === head ? `branch '${head}'` : `PR #${pr.number}`} is already bound to '${other.sliceSignature.replace(/^manifest:/, "")}' — ` +
        "two projections force-pushing one branch would each undo the other. Use `drip manifest forget` first if that binding is wrong.",
    );
  }

  // --- what the projection actually materializes ----------------------------
  // Flat-first, because that's what the manifest's dependsOn graph means and
  // what `push --manifest --projection flat-first` will send afterwards.
  const materialized = await materializeFlatFirst({
    git,
    repoRoot,
    mergeBase,
    files: plan.files,
    order: resolved.order,
    slices: resolved.units,
    edges: resolved.edges,
    label: (id) => id,
  });
  const mine = materialized.find((m) => m.sliceId === projectionId)!;
  const prerequisites = mine.prerequisites;
  const manifestBase = mine.integrationCommit
    ? `${head}-base`
    : mine.baseSliceId
      ? projectionBranch(db, branch, mine.baseSliceId)
      : baseBranch;
  const baseAgrees = pr.baseRefName === manifestBase;
  if (!baseAgrees) {
    add(
      "warning",
      "base-disagreement",
      `PR #${pr.number} targets '${pr.baseRefName}' but the manifest's graph implies '${manifestBase}'` +
        (mine.integrationCommit ? " (a generated integration base — it unions several prerequisites)" : "") +
        " — adoption records the base as it is; drip will not retarget it for you",
    );
  }

  const base: AdoptionCheck = {
    projectionId,
    pr,
    head,
    headSha,
    manifestBase,
    baseAgrees,
    prerequisites,
    commit: mine.commit,
    contentHash: null,
    interdiff: null,
    findings,
    ok: false,
  };

  if (!mine.commit) {
    add("error", "apply-failure", `does not apply on its own prerequisite closure (${mine.applyError ?? "unknown error"}) — fix the manifest before binding a PR to it`);
    return { ...base, ok: false };
  }

  // --- does the branch carry exactly this projection's content? -------------
  // Trees can't be compared directly: a handcrafted branch forked from
  // whatever `main` was that day, not from the mega branch's merge base. Its
  // *effective diff* can be, though — replay what the branch adds over the
  // base branch onto the merge base, and compare the result with the tree the
  // projection materializes.
  const projTree = git.revParse(`${mine.commit}^{tree}`, repoRoot);
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-adopt-"));
  const patchFile = join(tmpDir, "patch.diff");
  const env = { ...process.env, GIT_INDEX_FILE: join(tmpDir, "index") };
  const replay = (parent: string, patch: string): string => {
    git.readTree(parent, repoRoot, env);
    if (patch.trim()) {
      writeFileSync(patchFile, patch);
      git.applyCached(patchFile, repoRoot, env);
    }
    return git.writeTree(repoRoot, env);
  };

  try {
    const forkPoint = git.mergeBase(baseBranch, headSha, repoRoot);
    let branchTree: string;
    try {
      branchTree = replay(mergeBase, git.diff(forkPoint, headSha, repoRoot));
    } catch (e) {
      add(
        "error",
        "adopt-replay-failed",
        `the branch's diff (${forkPoint.slice(0, 7)}..${headSha.slice(0, 7)}) could not be replayed onto the mega branch's merge base ` +
          `${mergeBase.slice(0, 7)}: ${String(e)} — rebase '${head}' onto the same base the mega branch was cut from and try again`,
      );
      return { ...base, ok: false };
    }

    if (branchTree === projTree) {
      const contentHash = computeContentHash(
        [buildSlicePatch(plan.files, resolved.units, projectionId), projTree, manifestBase].join("\n--drip--\n"),
      );
      return { ...base, contentHash, ok: !findings.some((f) => f.severity === "error") };
    }

    // Mismatch. The single most common shape is worth naming outright, because
    // it looks identical to "wrong PR" in a raw interdiff and isn't: a branch
    // that carries its own change but is based on the base branch rather than
    // on the prerequisites the manifest says it needs.
    if (prerequisites.length) {
      let ownTree: string | null = null;
      try {
        ownTree = replay(mergeBase, buildSlicePatch(plan.files, resolved.units, projectionId));
      } catch {
        // The projection's own patch needing its prerequisites' context to
        // apply is itself informative — it just isn't this diagnosis.
      }
      if (ownTree === branchTree) {
        add(
          "error",
          "adopt-mismatch",
          `carries exactly this projection's own change, but not the prerequisite closure the manifest declares (${prerequisites.join(", ")}). ` +
            `Rebase '${head}' onto those, or correct the projection's dependsOn — its PR is not independently reviewable as it stands`,
        );
        return { ...base, interdiff: git.diff(projTree, branchTree, repoRoot).slice(0, INTERDIFF_LIMIT), ok: false };
      }
    }

    add(
      "error",
      "adopt-mismatch",
      `branch '${head}' does not contain this projection's materialized tree — see the interdiff below (projection → branch)`,
    );
    return { ...base, interdiff: git.diff(projTree, branchTree, repoRoot).slice(0, INTERDIFF_LIMIT), ok: false };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Records the binding. The commit sha stored is the *human's* head, not a
// drip-materialized one: it's what a later push leases against and diffs its
// interdiff from, so the first drip update is reported against the branch
// reviewers actually saw.
export function recordAdoption(db: Database, branch: string, check: AdoptionCheck): void {
  if (!check.ok) throw new DripError("refusing to record an adoption that did not validate");
  upsertCorrespondence(db, {
    branch,
    sliceSignature: manifestSignature(check.projectionId),
    sliceBranch: check.head,
    prNumber: check.pr.number,
    prUrl: check.pr.url || null,
    contentHash: check.contentHash,
    commitSha: check.headSha,
    // As it is, not as the manifest would have it — push reports the
    // disagreement rather than silently retargeting.
    baseRef: check.pr.baseRefName || null,
    adopted: true,
  });
}

export type Adoption = { projectionId: string; branch: string; prNumber: number | null; prUrl: string | null; baseRef: string | null; adopted: boolean };

// Every manifest projection this repo has a PR for, adopted or drip-created.
// Both are shown: "which of these did drip open?" is the question a reader of
// this list actually has.
export function listProjectionCorrespondence(db: Database, branch: string): Adoption[] {
  return listCorrespondence(db, branch)
    .filter((c) => c.sliceSignature.startsWith("manifest:"))
    .map((c) => ({
      projectionId: c.sliceSignature.slice("manifest:".length),
      branch: c.sliceBranch,
      prNumber: c.prNumber,
      prUrl: c.prUrl,
      baseRef: c.baseRef,
      adopted: c.adopted,
    }));
}

export function adoptionToJson(check: AdoptionCheck): object {
  return {
    ok: check.ok,
    projection: check.projectionId,
    pr: { number: check.pr.number, url: check.pr.url, state: check.pr.state, base: check.pr.baseRefName },
    head: check.head,
    headSha: check.headSha,
    manifestBase: check.manifestBase,
    baseAgrees: check.baseAgrees,
    prerequisites: check.prerequisites,
    findings: check.findings,
    interdiff: check.interdiff,
  };
}

export function printAdoptionReport(check: AdoptionCheck): void {
  console.log(`ADOPTION: ${check.projectionId} <- #${check.pr.number} (${check.head} @ ${check.headSha.slice(0, 7)})`);
  if (check.pr.title) console.log(`  PR: ${check.pr.title}`);
  console.log(`  base: ${check.pr.baseRefName || "(unknown)"}${check.baseAgrees ? " — agrees with the manifest graph" : ` — manifest implies ${check.manifestBase}`}`);
  console.log(`  prerequisites: ${check.prerequisites.length ? check.prerequisites.join(", ") : "none (targets the base branch directly)"}`);

  const errors = check.findings.filter((f) => f.severity === "error");
  const warnings = check.findings.filter((f) => f.severity === "warning");
  for (const [title, list] of [
    ["WARNINGS", warnings],
    ["ERRORS", errors],
  ] as const) {
    if (!list.length) continue;
    console.log(`\n${title}:`);
    for (const f of list) console.log(`  [${f.code}] ${f.message}`);
  }

  if (check.interdiff) {
    console.log("\nINTERDIFF (what the projection materializes → what the branch has):");
    for (const line of check.interdiff.split("\n")) console.log(`  ${line}`);
  }

  console.log(check.ok ? `\nADOPTION: PASS (${warnings.length} warning(s))` : `\nADOPTION: FAIL (${errors.length} error(s), ${warnings.length} warning(s))`);
}
