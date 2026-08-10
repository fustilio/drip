import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ShellGitBackend } from "./git-backend";
import type { ReviewComment } from "./github";
import { ManifestSchema, manifestSignature, resolveManifest, type Manifest } from "./manifest";
import { computePlan, type PlanResult } from "./planner";
import { collectReviewContext } from "./review-context";
import { markCommentProcessed, openStore, upsertCorrespondence } from "./store";
import { commit, git, githubMock, gitOutput, makeBareRemote, makeTempRepo } from "./test-helpers";

// issue #18: read-only review context for a projection.
//
// Every mutating GitHub export is mocked and asserted *uncalled* — the claim
// this command makes is that looking costs nothing, and a test that only
// checked the output would not be testing that claim. The comment listing is
// injected rather than mocked so the same suite can assert both the reported
// threads and the fact that nothing else was touched.

const ghCreatePr = mock((_opts: unknown) => ({ number: 0, url: "" }));
const ghPrClose = mock(() => {});
const ghPrComment = mock(() => {});
const ghPrSetBase = mock(() => {});
const ghReplyToReviewComment = mock(() => {});
mock.module("./github", () =>
  githubMock({
    ghCreatePr,
    ghPrClose,
    ghPrComment,
    ghPrSetBase,
    ghReplyToReviewComment,
    ghListReviewComments: mock(() => {
      throw new Error("collectReviewContext must not reach the real gh listing in tests");
    }),
  }),
);

const backend = new ShellGitBackend();
let repoRoot: string;
let remoteRoot: string;
let cleanupRepo: () => void;
let cleanupRemote: () => void;
let db: Database;

const HELPER_V2 = `export function shared(x: number) {\n  return x + 2;\n}\n`;

beforeEach(() => {
  ({ repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-review-context-"));
  ({ remoteRoot, cleanup: cleanupRemote } = makeBareRemote("drip-review-context-remote-"));
  git(["remote", "add", "origin", remoteRoot], repoRoot);

  writeFileSync(join(repoRoot, "helper.ts"), `export function shared(x: number) {\n  return x + 1;\n}\n`);
  writeFileSync(join(repoRoot, "a.ts"), `export function featureA() {\n  return 1;\n}\n`);
  commit(repoRoot, "init");
  git(["push", "-q", "origin", "main"], repoRoot);

  git(["checkout", "-q", "-b", "feature"], repoRoot);
  writeFileSync(join(repoRoot, "helper.ts"), HELPER_V2);
  writeFileSync(join(repoRoot, "a.ts"), `import { shared } from "./helper";\n\nexport function featureA() {\n  return shared(1);\n}\n`);
  commit(repoRoot, "feature");

  db = openStore(repoRoot);
  for (const m of [ghCreatePr, ghPrClose, ghPrComment, ghPrSetBase, ghReplyToReviewComment]) m.mockClear();
});

afterEach(() => {
  db.close();
  cleanupRepo();
  cleanupRemote();
});

const manifest = (): Manifest =>
  ManifestSchema.parse({
    version: 1,
    sourceBranch: "feature",
    projections: [
      { id: "helper", intent: "Bump the shared helper.", atomicSlices: ["helper.ts::shared"], verificationReason: "fixture" },
      { id: "feature-a", intent: "Route feature A through the helper.", atomicSlices: ["a.ts::featureA"], dependsOn: ["helper"], verificationReason: "fixture" },
    ],
  });

async function context() {
  const plan: PlanResult = await computePlan({ git: backend, repoRoot, branch: "feature", baseBranch: "main" });
  return { plan, mergeBase: backend.mergeBase("main", "feature", repoRoot), resolved: resolveManifest(plan, manifest(), { branch: "feature" }) };
}

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 1,
  path: "helper.ts",
  line: 2,
  originalLine: 2,
  side: "RIGHT",
  inReplyToId: null,
  body: "should this clamp at zero?\nmore detail",
  ...over,
});

async function collect(opts: { only?: string; readComments?: (repoRoot: string, pr: number) => ReviewComment[]; includeReview?: boolean } = {}) {
  const { plan, mergeBase, resolved } = await context();
  return collectReviewContext({
    git: backend,
    db,
    repoRoot,
    branch: "feature",
    baseBranch: "main",
    mergeBase,
    plan,
    resolved,
    only: opts.only ?? null,
    includeReview: opts.includeReview,
    readComments: opts.readComments,
  });
}

test("a projection with no PR reports that, rather than looking like it has nothing to review", async () => {
  const report = await collect();
  expect(report.projections.map((p) => p.projectionId)).toEqual(["helper", "feature-a"]);
  const helper = report.projections[0]!;
  expect(helper.correspondence).toBeNull();
  expect(helper.state).toBe("never-pushed");
  expect(helper.review.available).toBe(false);
  expect(helper.intent).toBe("Bump the shared helper.");
  expect(helper.dependsOn).toEqual([]);
});

test("a projection whose PR is current reports unchanged, with the base agreement stated", async () => {
  const { plan, mergeBase, resolved } = await context();
  // Record correspondence against the projection's own materialized commit —
  // what a push would have stored.
  const { materializeFlatFirst } = await import("./materialize");
  const flat = await materializeFlatFirst({
    git: backend,
    repoRoot,
    mergeBase,
    files: plan.files,
    order: resolved.order,
    slices: resolved.units,
    edges: resolved.edges,
    label: (id) => id,
  });
  const helperCommit = flat.find((f) => f.sliceId === "helper")!.commit!;
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "drip/feature/helper",
    prNumber: 7,
    prUrl: "https://example.com/pull/7",
    contentHash: "hash",
    commitSha: helperCommit,
    baseRef: "main",
    adopted: false,
  });

  const helper = (await collect({ only: "helper", readComments: () => [] })).projections[0]!;
  expect(helper.state).toBe("unchanged");
  expect(helper.changedSelectors).toEqual([]);
  expect(helper.correspondence).toMatchObject({ prNumber: 7, adopted: false, recordedBase: "main", manifestBase: "main", baseAgrees: true });
});

test("a projection the plan has moved under reports which selectors changed", async () => {
  // Record correspondence against the *base* tree: whatever the PR last saw,
  // it wasn't this projection's current content.
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "drip/feature/helper",
    prNumber: 7,
    prUrl: null,
    contentHash: "stale",
    commitSha: backend.revParse("main", repoRoot),
    baseRef: "main",
    adopted: false,
  });

  const helper = (await collect({ only: "helper", readComments: () => [] })).projections[0]!;
  expect(helper.state).toBe("changed");
  expect(helper.changedFiles).toEqual(["helper.ts"]);
  expect(helper.changedSelectors).toEqual(["helper.ts::shared"]);
});

test("a recorded commit this clone doesn't have is 'unknown', never guessed at", async () => {
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "team/helper",
    prNumber: 373,
    prUrl: null,
    contentHash: "hash",
    commitSha: "0".repeat(40),
    baseRef: "main",
    adopted: true,
  });

  const helper = (await collect({ only: "helper", readComments: () => [] })).projections[0]!;
  expect(helper.state).toBe("unknown");
  expect(helper.stateDetail).toContain("isn't in this clone");
  expect(helper.changedSelectors).toEqual([]);
});

test("open threads are reported with their replies, and drip's orphaned anchors alongside", async () => {
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "drip/feature/helper",
    prNumber: 7,
    prUrl: null,
    contentHash: "hash",
    commitSha: backend.revParse("main", repoRoot),
    baseRef: "main",
    adopted: false,
  });
  markCommentProcessed(db, 1, "feature", manifestSignature("helper"), "orphaned");
  markCommentProcessed(db, 9, "feature", manifestSignature("helper"), "unchanged");

  const helper = (
    await collect({
      only: "helper",
      readComments: () => [comment(), comment({ id: 2, inReplyToId: 1, body: "yes" }), comment({ id: 3, path: "helper.ts", line: 3, body: "naming?" })],
    })
  ).projections[0]!;

  expect(helper.review.available).toBe(true);
  if (!helper.review.available) throw new Error("unreachable");
  expect(helper.review.threads.map((t) => t.id)).toEqual([1, 3]); // replies fold into their thread
  expect(helper.review.threads[0]!.replies).toBe(1);
  expect(helper.review.threads[0]!.excerpt).toBe("should this clamp at zero?");
  expect(helper.review.orphanedAnchors).toBe(1);
  // The endpoint drip reads doesn't carry resolution state, and the report says so.
  expect(helper.review.resolutionStateKnown).toBe(false);
});

test("an unreachable gh is reported as unavailable, with the local half of the answer intact", async () => {
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "drip/feature/helper",
    prNumber: 7,
    prUrl: null,
    contentHash: "hash",
    commitSha: backend.revParse("main", repoRoot),
    baseRef: "main",
    adopted: false,
  });

  const helper = (
    await collect({
      only: "helper",
      readComments: () => {
        throw new Error("gh: command not found");
      },
    })
  ).projections[0]!;
  expect(helper.review.available).toBe(false);
  if (helper.review.available) throw new Error("unreachable");
  expect(helper.review.reason).toContain("gh: command not found");
  // The state comparison doesn't depend on GitHub, so it still answers.
  expect(helper.state).toBe("changed");
});

test("a base that no longer agrees with the manifest graph is reported without being changed", async () => {
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "team/helper",
    prNumber: 373,
    prUrl: null,
    contentHash: "hash",
    commitSha: backend.revParse("main", repoRoot),
    baseRef: "main",
    adopted: true,
  });
  const report = await collect({ readComments: () => [] });
  // feature-a depends on helper, whose adopted branch is team/helper — so the
  // manifest graph implies that, whatever the PR currently records.
  const featureA = report.projections.find((p) => p.projectionId === "feature-a")!;
  expect(featureA.correspondence).toBeNull();
  const helper = report.projections.find((p) => p.projectionId === "helper")!;
  expect(helper.correspondence!.baseAgrees).toBe(true);
  expect(ghPrSetBase).not.toHaveBeenCalled();
});

test("collecting review context writes nothing: no PR state, no comments, no refs, no correspondence", async () => {
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "drip/feature/helper",
    prNumber: 7,
    prUrl: null,
    contentHash: "hash",
    commitSha: backend.revParse("main", repoRoot),
    baseRef: "main",
    adopted: false,
  });
  const remoteRefs = gitOutput(["for-each-ref", "--format=%(refname) %(objectname)"], remoteRoot);
  const localRefs = gitOutput(["for-each-ref", "--format=%(refname) %(objectname)"], repoRoot);
  const correspondenceBefore = db.query("SELECT * FROM correspondence").all();
  const anchorsBefore = db.query("SELECT * FROM comment_anchors").all();

  await collect({ readComments: () => [comment()] });

  expect(gitOutput(["for-each-ref", "--format=%(refname) %(objectname)"], remoteRoot)).toBe(remoteRefs);
  expect(gitOutput(["for-each-ref", "--format=%(refname) %(objectname)"], repoRoot)).toBe(localRefs);
  expect(db.query("SELECT * FROM correspondence").all()).toEqual(correspondenceBefore);
  expect(db.query("SELECT * FROM comment_anchors").all()).toEqual(anchorsBefore);
  for (const write of [ghCreatePr, ghPrClose, ghPrComment, ghPrSetBase, ghReplyToReviewComment]) expect(write).not.toHaveBeenCalled();
});

test("--no-review skips the GitHub read entirely and says so", async () => {
  upsertCorrespondence(db, {
    branch: "feature",
    sliceSignature: manifestSignature("helper"),
    sliceBranch: "drip/feature/helper",
    prNumber: 7,
    prUrl: null,
    contentHash: "hash",
    commitSha: backend.revParse("main", repoRoot),
    baseRef: "main",
    adopted: false,
  });
  const reader = mock(() => [] as ReviewComment[]);
  const helper = (await collect({ only: "helper", includeReview: false, readComments: reader })).projections[0]!;
  expect(reader).not.toHaveBeenCalled();
  expect(helper.review.available).toBe(false);
  if (helper.review.available) throw new Error("unreachable");
  expect(helper.review.reason).toContain("not requested");
  expect(helper.state).toBe("changed"); // the local half is unaffected
});
