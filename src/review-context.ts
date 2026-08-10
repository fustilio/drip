import type { Database } from "bun:sqlite";
import { projectionBranch } from "./adopt";
import type { GitBackend } from "./git-backend";
import { ghListReviewComments, type ReviewComment } from "./github";
import { manifestSignature, type ResolvedManifest } from "./manifest";
import { materializeFlatFirst } from "./materialize";
import { groupKeyOf, type PlanResult } from "./planner";
import { getCorrespondence, listCommentAnchors } from "./store";

// Review context for a projection (issue #18).
//
// Everything drip knows about a projection's review surface is spread across
// three places: the manifest says what the projection is meant to be, the store
// says which branch and PR it corresponds to and what content was last sent
// there, and GitHub holds the comments. Answering "what is the state of this
// PR, and has the thing under it moved since anyone looked?" currently means
// reading a push report, a `manifest list` line and the PR itself, and joining
// them by hand.
//
// This joins them, and does nothing else. It is read-only by construction: the
// only GitHub call is the same comment *listing* the anchor system already
// uses, there is no code path here that comments, replies, resolves, pushes or
// records anything, and a projection's materialization happens in a scratch
// index exactly as `validate-plan` does it. That constraint is the feature —
// the thing an external tool most wants is a way to look without touching.

export type ReviewThread = {
  id: number;
  path: string;
  line: number | null;
  replies: number;
  /** first line of the comment, enough to recognise the thread by */
  excerpt: string;
};

export type ReviewSurface =
  | {
      available: true;
      threads: ReviewThread[];
      /** comments drip could not confidently relocate on an earlier push (docs/adr/0007) */
      orphanedAnchors: number;
      /**
       * GitHub's REST comments endpoint doesn't carry thread resolution state
       * (that's GraphQL only), so "unresolved" here means "an open thread drip
       * can see", not "not marked resolved". Said out loud rather than implied.
       */
      resolutionStateKnown: false;
    }
  | { available: false; reason: string };

export type ProjectionReviewContext = {
  projectionId: string;
  title: string;
  intent: string | null;
  dependsOn: string[];
  files: string[];
  hunkCount: number;
  changedLines: number;
  /** where this projection's PR lives, once one exists */
  correspondence: {
    branch: string;
    prNumber: number | null;
    prUrl: string | null;
    adopted: boolean;
    /** the base recorded when the PR was last pushed or adopted */
    recordedBase: string | null;
    /** the base the manifest's graph implies today */
    manifestBase: string;
    baseAgrees: boolean;
  } | null;
  /**
   * How the projection's current content compares with what its PR last
   * received. "unknown" is a real answer — an adopted branch whose recorded sha
   * isn't in this clone can't be compared without fetching, and quietly
   * reporting "changed" would be a guess.
   */
  state: "never-pushed" | "unchanged" | "changed" | "unknown" | "not-materializable";
  stateDetail: string | null;
  changedFiles: string[];
  /** the durable selectors whose files moved since the PR last saw this projection */
  changedSelectors: string[];
  review: ReviewSurface;
};

export type ReviewContextReport = {
  branch: string;
  projections: ProjectionReviewContext[];
};

/** Injected so tests can assert the read-only boundary without a `gh` binary. */
export type ReviewCommentReader = (repoRoot: string, prNumber: number) => ReviewComment[];

export async function collectReviewContext(opts: {
  git: GitBackend;
  db: Database;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  mergeBase: string;
  plan: PlanResult;
  resolved: ResolvedManifest;
  /** restrict to one projection; omit for all of them */
  only?: string | null;
  /** skip the GitHub read entirely (offline, or when only the local state is wanted) */
  includeReview?: boolean;
  readComments?: ReviewCommentReader;
}): Promise<ReviewContextReport> {
  const { git, db, repoRoot, branch, baseBranch, mergeBase, plan, resolved } = opts;
  const includeReview = opts.includeReview ?? true;
  const readComments = opts.readComments ?? ghListReviewComments;
  const wanted = opts.only ? resolved.projections.filter((p) => p.id === opts.only) : resolved.projections;

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
  const byId = new Map(materialized.map((m) => [m.sliceId, m]));

  const treeOf = (commitish: string): string | null => {
    try {
      return git.revParse(`${commitish}^{tree}`, repoRoot);
    } catch {
      return null;
    }
  };

  const projections: ProjectionReviewContext[] = [];
  for (const projection of wanted) {
    const flat = byId.get(projection.id)!;
    const existing = getCorrespondence(db, branch, manifestSignature(projection.id));

    // Same base selection push would make, so a disagreement reported here is
    // the disagreement a push would report — not a second opinion.
    const manifestBase = flat.integrationCommit
      ? `${projectionBranch(db, branch, projection.id)}-base`
      : flat.baseSliceId
        ? projectionBranch(db, branch, flat.baseSliceId)
        : baseBranch;

    let state: ProjectionReviewContext["state"] = "never-pushed";
    let stateDetail: string | null = null;
    let changedFiles: string[] = [];

    if (!flat.commit) {
      state = "not-materializable";
      stateDetail = flat.applyError ?? "does not apply on its declared prerequisites";
    } else if (!existing) {
      // "never-pushed" already says it; a detail here would just repeat the line.
    } else if (!existing.commitSha) {
      state = "unknown";
      stateDetail = "correspondence records no commit for the last push, so there is nothing to compare against";
    } else {
      const before = treeOf(existing.commitSha);
      const now = treeOf(flat.commit);
      if (!before) {
        state = "unknown";
        stateDetail = `the recorded commit ${existing.commitSha.slice(0, 7)} isn't in this clone — fetch ${existing.sliceBranch} to compare`;
      } else if (before === now) {
        state = "unchanged";
      } else {
        state = "changed";
        changedFiles = git.diffNameStatus(before, now!, repoRoot).map((f) => f.path).sort();
      }
    }

    const changedSet = new Set(changedFiles);
    const changedSelectors = [
      ...new Set(
        (resolved.units.get(projection.id) ?? [])
          .filter((h) => changedSet.has(h.file))
          .map(groupKeyOf),
      ),
    ].sort();

    let review: ReviewSurface = { available: false, reason: "no PR corresponds to this projection yet" };
    if (existing?.prNumber) {
      if (!includeReview) {
        review = { available: false, reason: "not requested (--no-review)" };
      } else {
        try {
          const comments = readComments(repoRoot, existing.prNumber);
          const replies = new Map<number, number>();
          for (const c of comments) if (c.inReplyToId) replies.set(c.inReplyToId, (replies.get(c.inReplyToId) ?? 0) + 1);
          review = {
            available: true,
            threads: comments
              .filter((c) => !c.inReplyToId)
              .map((c) => ({
                id: c.id,
                path: c.path,
                line: c.line ?? c.originalLine,
                replies: replies.get(c.id) ?? 0,
                excerpt: (c.body.split("\n").find((l) => l.trim().length > 0) ?? "").slice(0, 120),
              })),
            orphanedAnchors: 0,
            resolutionStateKnown: false,
          };
        } catch (e) {
          // A missing or unauthenticated `gh` is an ordinary condition here, not
          // a failure of the command: the local half of the answer is still
          // worth having, so it's reported alongside why the rest is missing.
          review = { available: false, reason: e instanceof Error ? e.message : String(e) };
        }
      }
    }

    if (review.available) {
      review.orphanedAnchors = listCommentAnchors(db, branch, manifestSignature(projection.id)).filter((a) => a.status === "orphaned").length;
    }

    projections.push({
      projectionId: projection.id,
      title: projection.title,
      intent: projection.intent,
      dependsOn: projection.dependsOn,
      files: projection.files,
      hunkCount: projection.hunkCount,
      changedLines: projection.changedLines,
      correspondence: existing
        ? {
            branch: existing.sliceBranch,
            prNumber: existing.prNumber,
            prUrl: existing.prUrl,
            adopted: existing.adopted,
            recordedBase: existing.baseRef,
            manifestBase,
            baseAgrees: existing.baseRef === manifestBase,
          }
        : null,
      state,
      stateDetail,
      changedFiles,
      changedSelectors,
      review,
    });
  }

  return { branch, projections };
}

export function reviewContextToJson(report: ReviewContextReport): object {
  return {
    branch: report.branch,
    readOnly: true,
    projections: report.projections.map((p) => ({
      projection: p.projectionId,
      title: p.title,
      intent: p.intent,
      dependsOn: p.dependsOn,
      files: p.files,
      hunks: p.hunkCount,
      changedLines: p.changedLines,
      correspondence: p.correspondence,
      state: p.state,
      stateDetail: p.stateDetail,
      changedFiles: p.changedFiles,
      changedSelectors: p.changedSelectors,
      review: p.review,
    })),
  };
}

const STATE_TEXT: Record<ProjectionReviewContext["state"], string> = {
  "never-pushed": "no PR yet",
  unchanged: "PR matches the current plan",
  changed: "the plan has moved since the PR was last updated",
  unknown: "can't tell",
  "not-materializable": "does not apply on its prerequisites",
};

export function printReviewContext(report: ReviewContextReport): void {
  console.log(`REVIEW CONTEXT (${report.branch}, ${report.projections.length} projection(s)) — read-only:`);
  for (const p of report.projections) {
    console.log(`\n  ${p.projectionId} — ${p.title}`);
    if (p.intent) console.log(`    intent: ${p.intent}`);
    if (p.dependsOn.length) console.log(`    requires: ${p.dependsOn.join(", ")}`);
    console.log(`    ${p.files.length} file(s), ${p.hunkCount} hunk(s), ${p.changedLines} changed line(s)`);

    if (p.correspondence) {
      const c = p.correspondence;
      console.log(
        `    PR: ${c.prNumber ? `#${c.prNumber}` : "(none recorded)"} on ${c.branch} [${c.adopted ? "adopted" : "drip"}]${c.prUrl ? ` ${c.prUrl}` : ""}`,
      );
      console.log(
        `    base: ${c.recordedBase ?? "(unrecorded)"}${c.baseAgrees ? " — agrees with the manifest graph" : ` — the manifest graph implies ${c.manifestBase}`}`,
      );
    } else {
      console.log("    PR: none — this projection has never been pushed or adopted");
    }

    console.log(`    state: ${STATE_TEXT[p.state]}${p.stateDetail ? ` (${p.stateDetail})` : ""}`);
    if (p.changedSelectors.length) {
      console.log(`    changed since the PR last saw it: ${p.changedFiles.join(", ")}`);
      for (const s of p.changedSelectors) console.log(`      ${s}`);
    }

    if (!p.review.available) {
      console.log(`    review: unavailable — ${p.review.reason}`);
      continue;
    }
    const { threads, orphanedAnchors } = p.review;
    console.log(`    review: ${threads.length} open thread(s)${orphanedAnchors ? `, ${orphanedAnchors} comment(s) drip could not relocate` : ""}`);
    for (const t of threads) {
      console.log(`      ${t.path}${t.line ? `:${t.line}` : ""}${t.replies ? ` (+${t.replies} repl${t.replies === 1 ? "y" : "ies"})` : ""}: ${t.excerpt}`);
    }
    if (threads.length) {
      console.log("      (thread resolution state isn't exposed by the endpoint drip reads — these are the threads it can see, not the unresolved ones)");
    }
  }
  console.log("\nNothing was written: no comment, no reply, no branch, no PR state, no correspondence.");
}
