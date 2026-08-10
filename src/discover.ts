import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { listProjectionCorrespondence } from "./adopt";
import type { GitBackend } from "./git-backend";
import type { PrSummary } from "./github";
import type { ResolvedManifest } from "./manifest";
import { buildSlicePatch, materializeFlatFirst } from "./materialize";
import type { PlanResult } from "./planner";
import { dripBranchName } from "./refs";

// Guided adoption (issue #17).
//
// `drip manifest adopt` requires the projection id, the PR number and the head
// branch, and cross-checks all three (docs/adr/0020). That is the right bar for
// the write — a wrong guess there eventually force-pushes over someone else's
// branch — but it leaves the reader to work out the mapping by hand, against a
// list of open PRs whose titles say what someone meant rather than what the
// branch contains. Guessing is precisely what the command was designed to stop,
// so doing it by hand instead of in code is no safer.
//
// So discovery answers the same question adoption asks, without writing
// anything: for each projection, is there an open PR whose branch content *is*
// this projection? The evidence is identical — the branch's effective diff,
// replayed onto the mega branch's merge base, compared against the tree the
// projection materializes. Nothing here scores titles, branch-name similarity
// or authorship; a PR either carries the tree or it doesn't.
//
// The output is a command to review and run, not an action taken. Adoption
// stays a decision a human makes with --yes.

export type CandidateEvidence =
  /** the branch replays to exactly this projection's materialized tree */
  | "exact-tree"
  /** it carries the projection's own change but not the prerequisite closure the manifest declares */
  | "own-change-only";

export type AdoptionCandidate = {
  projectionId: string;
  pr: PrSummary;
  evidence: CandidateEvidence;
  /** the exact `drip manifest adopt` invocation, for the reader to check and run */
  command: string;
  note: string | null;
};

export type DiscoveryReport = {
  branch: string;
  remote: string;
  /** open PRs actually examined (after skipping drip-owned and already-bound branches) */
  examined: number;
  candidates: AdoptionCandidate[];
  bound: Array<{ projectionId: string; head: string; prNumber: number | null; adopted: boolean }>;
  unmatched: Array<{ projectionId: string; reason: string }>;
  skipped: Array<{ head: string; prNumber: number; reason: string }>;
};

const adoptCommand = (branch: string, projectionId: string, pr: PrSummary) =>
  `drip manifest adopt ${branch} --projection ${projectionId} --pr ${pr.number} --head ${pr.headRefName} --yes`;

export async function discoverAdoptionCandidates(opts: {
  git: GitBackend;
  db: Database;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  mergeBase: string;
  plan: PlanResult;
  resolved: ResolvedManifest;
  remote: string;
  /** the open PRs to consider — passed in so the caller owns the one GitHub read */
  prs: PrSummary[];
}): Promise<DiscoveryReport> {
  const { git, db, repoRoot, branch, baseBranch, mergeBase, plan, resolved, remote, prs } = opts;

  const correspondence = listProjectionCorrespondence(db, branch);
  const boundProjections = new Set(correspondence.map((c) => c.projectionId));
  const boundHeads = new Set(correspondence.map((c) => c.branch));

  // --- what each unbound projection materializes ------------------------------
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

  const unmatched: DiscoveryReport["unmatched"] = [];
  const targets: Array<{ id: string; tree: string; ownTree: string | null; prerequisites: string[] }> = [];

  const tmpDir = mkdtempSync(join(tmpdir(), "drip-discover-"));
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
    for (const m of materialized) {
      if (boundProjections.has(m.sliceId)) continue;
      if (!m.commit) {
        unmatched.push({
          projectionId: m.sliceId,
          reason: `does not apply on its declared prerequisites (${m.applyError ?? "unknown error"}) — nothing to compare a branch against`,
        });
        continue;
      }
      // The own-change-only tree is what a branch cut from the base branch
      // rather than from its prerequisites looks like. Computing it up front
      // costs one index replay per projection and turns the commonest
      // near-miss from "no candidate" into a named, actionable one.
      let ownTree: string | null = null;
      if (m.prerequisites.length) {
        try {
          ownTree = replay(mergeBase, buildSlicePatch(plan.files, resolved.units, m.sliceId));
        } catch {
          // A projection whose own patch needs its prerequisites' context to
          // apply simply has no such near-miss shape to look for.
        }
      }
      targets.push({ id: m.sliceId, tree: git.revParse(`${m.commit}^{tree}`, repoRoot), ownTree, prerequisites: m.prerequisites });
    }

    // --- what each open PR's branch actually contains --------------------------
    const skipped: DiscoveryReport["skipped"] = [];
    const branchTrees: Array<{ pr: PrSummary; tree: string }> = [];
    let examined = 0;
    for (const pr of prs) {
      // A branch drip owns is drip's own output, and one already bound belongs
      // to a projection: neither is a discovery.
      if (pr.headRefName.startsWith(dripBranchName(branch, ""))) continue;
      if (boundHeads.has(pr.headRefName)) continue;
      examined++;
      let headSha: string;
      try {
        git.fetch(remote, pr.headRefName, repoRoot);
        headSha = git.revParse("FETCH_HEAD", repoRoot);
      } catch (e: any) {
        skipped.push({ head: pr.headRefName, prNumber: pr.number, reason: `could not fetch from ${remote}: ${String(e.stderr ?? e.message ?? e).trim()}` });
        continue;
      }
      try {
        const forkPoint = git.mergeBase(baseBranch, headSha, repoRoot);
        branchTrees.push({ pr, tree: replay(mergeBase, git.diff(forkPoint, headSha, repoRoot)) });
      } catch (e) {
        // Same diagnosis adoption gives for this case: a branch cut from a much
        // older base can be right and still not replay.
        skipped.push({
          head: pr.headRefName,
          prNumber: pr.number,
          reason: `its diff could not be replayed onto the mega branch's merge base (${String(e).split("\n")[0]}) — rebase it and re-run`,
        });
      }
    }

    // --- match, on tree equality and nothing else ------------------------------
    const candidates: AdoptionCandidate[] = [];
    for (const target of targets) {
      const exact = branchTrees.filter((b) => b.tree === target.tree);
      for (const hit of exact) {
        candidates.push({
          projectionId: target.id,
          pr: hit.pr,
          evidence: "exact-tree",
          command: adoptCommand(branch, target.id, hit.pr),
          note:
            exact.length > 1
              ? `${exact.length} open PRs carry this exact tree — they are indistinguishable by content, so the choice is yours`
              : null,
        });
      }
      if (exact.length) continue;

      const near = target.ownTree ? branchTrees.filter((b) => b.tree === target.ownTree) : [];
      for (const hit of near) {
        candidates.push({
          projectionId: target.id,
          pr: hit.pr,
          evidence: "own-change-only",
          command: adoptCommand(branch, target.id, hit.pr),
          note:
            `carries this projection's own change but not the prerequisite closure the manifest declares (${target.prerequisites.join(", ")}) — ` +
            `adoption will refuse until '${hit.pr.headRefName}' is rebased onto those, or the projection's dependsOn is corrected`,
        });
      }
      if (!near.length) {
        unmatched.push({
          projectionId: target.id,
          reason: "no open PR's branch replays to this projection's tree — nothing here is evidence enough to adopt",
        });
      }
    }

    return {
      branch,
      remote,
      examined,
      candidates,
      bound: correspondence.map((c) => ({ projectionId: c.projectionId, head: c.branch, prNumber: c.prNumber, adopted: c.adopted })),
      unmatched,
      skipped,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function discoveryToJson(report: DiscoveryReport): object {
  return {
    branch: report.branch,
    remote: report.remote,
    examined: report.examined,
    candidates: report.candidates.map((c) => ({
      projection: c.projectionId,
      pr: { number: c.pr.number, url: c.pr.url, title: c.pr.title, head: c.pr.headRefName, base: c.pr.baseRefName },
      evidence: c.evidence,
      command: c.command,
      note: c.note,
    })),
    bound: report.bound,
    unmatched: report.unmatched,
    skipped: report.skipped,
  };
}

export function printDiscoveryReport(report: DiscoveryReport): void {
  console.log(`ADOPTION CANDIDATES (${report.branch}, ${report.examined} open PR(s) examined on ${report.remote}):`);
  if (!report.candidates.length) console.log("  none — no open PR's content matches a projection in this manifest");

  for (const c of report.candidates) {
    console.log(
      `  ${c.projectionId} <- #${c.pr.number} ${c.pr.headRefName}${c.pr.title ? ` — ${c.pr.title}` : ""} [${c.evidence === "exact-tree" ? "exact tree match" : "own change only"}]`,
    );
    if (c.note) console.log(`      ${c.note}`);
    console.log(`      ${c.command}`);
  }

  if (report.bound.length) {
    console.log("\nALREADY BOUND (nothing to discover):");
    for (const b of report.bound) console.log(`  ${b.projectionId} -> ${b.head}${b.prNumber ? ` #${b.prNumber}` : ""} [${b.adopted ? "adopted" : "drip"}]`);
  }

  if (report.unmatched.length) {
    console.log("\nNO CANDIDATE:");
    for (const u of report.unmatched) console.log(`  ${u.projectionId}: ${u.reason}`);
  }

  if (report.skipped.length) {
    console.log("\nSKIPPED PRs:");
    for (const s of report.skipped) console.log(`  #${s.prNumber} ${s.head}: ${s.reason}`);
  }

  console.log(
    `\nDISCOVERY: read-only — nothing was recorded, pushed or commented on. Adoption stays an explicit \`drip manifest adopt ... --yes\`,\n` +
      "  and re-checks all three of projection, PR and head branch before it binds anything.",
  );
}
