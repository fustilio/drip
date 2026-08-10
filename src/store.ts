import { Database } from "bun:sqlite";
import { DripError } from "./errors";
import { gitPath } from "./repo";

export type OverrideKind = "force_merge" | "force_split";

// selector format: "file::QualifiedSymbolPath" — see docs/adr/0004-override-selector.md
export type Override = {
  id?: number;
  kind: OverrideKind;
  selectorA: string;
  selectorB: string | null; // null for force_split
  note: string | null;
};

export function openStore(repoRoot: string): Database {
  // See docs/adr/0011-drip-db-location.md for why this isn't `<repoRoot>/.git`.
  const db = new Database(gitPath(repoRoot, "drip.db"), { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('force_merge','force_split')),
      selector_a TEXT NOT NULL,
      selector_b TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS timing_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      command TEXT NOT NULL CHECK (command IN ('plan','verify')),
      hunk_count INTEGER NOT NULL,
      slice_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS correspondence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      slice_signature TEXT NOT NULL,
      slice_branch TEXT NOT NULL,
      pr_number INTEGER,
      pr_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(branch, slice_signature)
    )
  `);
  // M3: content-addressed skip + interdiff need the last-pushed content hash
  // and commit sha. base_ref records what the PR was last targeted at, so a
  // changed base (e.g. switching --projection) is detected locally instead of
  // costing a `gh pr view` per slice on every run. ALTER TABLE ADD COLUMN has
  // no IF NOT EXISTS — swallow the "duplicate column" error on repos that
  // already have this table.
  //
  // adopted marks a row drip did not create: a pre-existing PR bound to a
  // manifest projection by `drip manifest adopt` (issue #11). Push treats
  // those branches as someone else's property — leased force-push, no silent
  // retargeting — so the flag has to survive in the durable record, not be
  // re-derived from the branch name.
  for (const col of ["content_hash TEXT", "commit_sha TEXT", "base_ref TEXT", "adopted INTEGER NOT NULL DEFAULT 0"]) {
    try {
      db.run(`ALTER TABLE correspondence ADD COLUMN ${col}`);
    } catch {}
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS comment_anchors (
      pr_comment_id INTEGER PRIMARY KEY,
      branch TEXT NOT NULL,
      slice_signature TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('unchanged','orphaned')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // M5: per-slice build-check cache, keyed the same way as correspondence.
  // A cached PASS is reused only for an unbroken unchanged prefix of the
  // stack (see verify.ts) -- see docs/adr/0008-build-cache-scope.md.
  db.run(`
    CREATE TABLE IF NOT EXISTS build_cache (
      branch TEXT NOT NULL,
      slice_signature TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      passed INTEGER NOT NULL,
      output TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(branch, slice_signature)
    )
  `);
  // Stack provenance (docs/adr/0030). Deliberately *not* a mirror of GitHub's
  // stack membership — that lives on GitHub and is read live, because a cached
  // copy could only ever be wrong. What's recorded here is the one fact GitHub
  // does not carry: whether drip created this stack. It is the same
  // drip-owned/adopted distinction correspondence already makes for branches
  // and PRs (docs/adr/0020, 0028), applied to the third object drip puts on
  // someone's review surface, so a stack drip made can be rebuilt from the
  // mega branch and a stack someone else made never is.
  db.run(`
    CREATE TABLE IF NOT EXISTS stack_ownership (
      branch TEXT NOT NULL,
      stack_number INTEGER NOT NULL,
      bottom_pr INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(branch, stack_number)
    )
  `);
  // Issue #10: manifest verification commands are real process runs, often a
  // package typecheck or a targeted test suite. Keyed by the tree the command
  // ran against, so an independent projection isn't re-verified because some
  // unrelated projection changed.
  db.run(`
    CREATE TABLE IF NOT EXISTS manifest_verification (
      branch TEXT NOT NULL,
      projection_id TEXT NOT NULL,
      command TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      passed INTEGER NOT NULL,
      exit_code INTEGER,
      output_path TEXT,
      duration_ms INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(branch, projection_id, command)
    )
  `);
  return db;
}

export type VerificationCacheEntry = { treeHash: string; passed: boolean; exitCode: number | null; outputPath: string | null; durationMs: number | null };

export function getVerificationCache(db: Database, branch: string, projectionId: string, command: string): VerificationCacheEntry | null {
  const row = db
    .query(
      "SELECT tree_hash as treeHash, passed, exit_code as exitCode, output_path as outputPath, duration_ms as durationMs FROM manifest_verification WHERE branch = ? AND projection_id = ? AND command = ?",
    )
    .get(branch, projectionId, command) as { treeHash: string; passed: number; exitCode: number | null; outputPath: string | null; durationMs: number | null } | null;
  return row ? { ...row, passed: !!row.passed } : null;
}

export function upsertVerificationCache(db: Database, branch: string, projectionId: string, command: string, entry: VerificationCacheEntry): void {
  db.query(
    `INSERT INTO manifest_verification (branch, projection_id, command, tree_hash, passed, exit_code, output_path, duration_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(branch, projection_id, command) DO UPDATE SET
       tree_hash = excluded.tree_hash, passed = excluded.passed, exit_code = excluded.exit_code,
       output_path = excluded.output_path, duration_ms = excluded.duration_ms, updated_at = datetime('now')`,
  ).run(branch, projectionId, command, entry.treeHash, entry.passed ? 1 : 0, entry.exitCode, entry.outputPath, entry.durationMs);
}

// slice_signature identifies "the same logical slice" across re-runs of
// `drip push` — see docs/adr/0006-slice-correspondence-key.md.
export type Correspondence = {
  id?: number;
  branch: string;
  sliceSignature: string;
  sliceBranch: string;
  prNumber: number | null;
  prUrl: string | null;
  contentHash: string | null;
  commitSha: string | null;
  baseRef: string | null;
  /** true when the PR/branch pre-existed drip and was bound by `manifest adopt` */
  adopted: boolean;
};

const CORRESPONDENCE_COLUMNS =
  "id, branch, slice_signature as sliceSignature, slice_branch as sliceBranch, pr_number as prNumber, pr_url as prUrl, content_hash as contentHash, commit_sha as commitSha, base_ref as baseRef, adopted";

type CorrespondenceRow = Omit<Correspondence, "adopted"> & { adopted: number | null };
const toCorrespondence = (row: CorrespondenceRow): Correspondence => ({ ...row, adopted: !!row.adopted });

export function getCorrespondence(db: Database, branch: string, sliceSignature: string): Correspondence | null {
  const row = db
    .query(`SELECT ${CORRESPONDENCE_COLUMNS} FROM correspondence WHERE branch = ? AND slice_signature = ?`)
    .get(branch, sliceSignature) as CorrespondenceRow | null;
  return row ? toCorrespondence(row) : null;
}

export function listCorrespondence(db: Database, branch: string): Correspondence[] {
  const rows = db
    .query(`SELECT ${CORRESPONDENCE_COLUMNS} FROM correspondence WHERE branch = ? ORDER BY slice_signature`)
    .all(branch) as CorrespondenceRow[];
  return rows.map(toCorrespondence);
}

export function upsertCorrespondence(db: Database, c: Correspondence): void {
  db.query(
    `INSERT INTO correspondence (branch, slice_signature, slice_branch, pr_number, pr_url, content_hash, commit_sha, base_ref, adopted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(branch, slice_signature) DO UPDATE SET
       slice_branch = excluded.slice_branch,
       pr_number = excluded.pr_number,
       pr_url = excluded.pr_url,
       content_hash = excluded.content_hash,
       commit_sha = excluded.commit_sha,
       base_ref = excluded.base_ref,
       adopted = excluded.adopted,
       updated_at = datetime('now')`,
  ).run(c.branch, c.sliceSignature, c.sliceBranch, c.prNumber, c.prUrl, c.contentHash, c.commitSha, c.baseRef, c.adopted ? 1 : 0);
}

export function deleteCorrespondence(db: Database, branch: string, sliceSignature: string): void {
  db.query("DELETE FROM correspondence WHERE branch = ? AND slice_signature = ?").run(branch, sliceSignature);
}

/** A stack drip created for this mega branch — provenance, not a membership cache. */
export type OwnedStack = { branch: string; stackNumber: number; bottomPr: number | null; createdAt: string };

export function recordStackOwnership(db: Database, branch: string, stackNumber: number, bottomPr: number | null): void {
  db.query(
    `INSERT INTO stack_ownership (branch, stack_number, bottom_pr) VALUES (?, ?, ?)
     ON CONFLICT(branch, stack_number) DO UPDATE SET bottom_pr = excluded.bottom_pr`,
  ).run(branch, stackNumber, bottomPr);
}

export function listOwnedStacks(db: Database, branch: string): OwnedStack[] {
  return db
    .query(
      "SELECT branch, stack_number as stackNumber, bottom_pr as bottomPr, created_at as createdAt FROM stack_ownership WHERE branch = ? ORDER BY stack_number",
    )
    .all(branch) as OwnedStack[];
}

export function isStackOwned(db: Database, branch: string, stackNumber: number): boolean {
  return !!db.query("SELECT 1 FROM stack_ownership WHERE branch = ? AND stack_number = ?").get(branch, stackNumber);
}

/** Drop the record, for a stack that was dissolved on GitHub or bound by mistake. */
export function forgetStackOwnership(db: Database, branch: string, stackNumber: number): void {
  db.query("DELETE FROM stack_ownership WHERE branch = ? AND stack_number = ?").run(branch, stackNumber);
}

export function listOverrides(db: Database, branch: string): Override[] {
  const rows = db
    .query("SELECT id, kind, selector_a as selectorA, selector_b as selectorB, note FROM overrides WHERE branch = ?")
    .all(branch) as Override[];
  return rows;
}

// Selector format is "file::QualifiedSymbolPath" (docs/adr/0004-override-selector.md).
// Validated here, at the durable-write boundary, so every caller gets it —
// not just whichever ones remembered to check first.
function validateSelector(label: string, selector: string): void {
  if (!selector.includes("::")) {
    throw new DripError(`${label} '${selector}' doesn't look like 'file::QualifiedSymbolPath' — missing '::'`);
  }
}

export function addOverride(
  db: Database,
  branch: string,
  kind: string,
  selectorA: string,
  selectorB: string | null,
  note: string | null,
): void {
  if (kind !== "force_merge" && kind !== "force_split") throw new DripError("kind must be 'force_merge' or 'force_split'");
  validateSelector("selectorA", selectorA);
  if (kind === "force_merge" && !selectorB) throw new DripError("force_merge requires selectorB");
  if (kind === "force_split" && selectorB) throw new DripError("force_split takes only selectorA, not selectorB");
  if (selectorB) validateSelector("selectorB", selectorB);

  db.query("INSERT INTO overrides (branch, kind, selector_a, selector_b, note) VALUES (?, ?, ?, ?, ?)").run(
    branch,
    kind,
    selectorA,
    selectorB,
    note,
  );
}

export function removeOverride(db: Database, id: number): boolean {
  const result = db.query("DELETE FROM overrides WHERE id = ?").run(id);
  return result.changes > 0;
}

export function wasCommentProcessed(db: Database, prCommentId: number): boolean {
  return !!db.query("SELECT 1 FROM comment_anchors WHERE pr_comment_id = ?").get(prCommentId);
}

export type CommentAnchor = { prCommentId: number; status: "unchanged" | "orphaned" };

// Every review comment drip has already reconciled for a unit, with what
// happened to it. Read-only, for reporting a projection's review surface
// (issue #18): an `orphaned` row is a comment drip could not confidently
// relocate and replied to, which is the one piece of unresolved review context
// drip itself knows about.
export function listCommentAnchors(db: Database, branch: string, sliceSignature: string): CommentAnchor[] {
  return db
    .query("SELECT pr_comment_id as prCommentId, status FROM comment_anchors WHERE branch = ? AND slice_signature = ? ORDER BY pr_comment_id")
    .all(branch, sliceSignature) as CommentAnchor[];
}

export function markCommentProcessed(db: Database, prCommentId: number, branch: string, sliceSignature: string, status: "unchanged" | "orphaned"): void {
  db.query(
    "INSERT OR IGNORE INTO comment_anchors (pr_comment_id, branch, slice_signature, status) VALUES (?, ?, ?, ?)",
  ).run(prCommentId, branch, sliceSignature, status);
}

export type BuildCacheEntry = { contentHash: string; passed: boolean; output: string | null };

export function getBuildCache(db: Database, branch: string, sliceSignature: string): BuildCacheEntry | null {
  const row = db
    .query("SELECT content_hash as contentHash, passed, output FROM build_cache WHERE branch = ? AND slice_signature = ?")
    .get(branch, sliceSignature) as { contentHash: string; passed: number; output: string | null } | null;
  return row ? { contentHash: row.contentHash, passed: !!row.passed, output: row.output } : null;
}

export function upsertBuildCache(db: Database, branch: string, sliceSignature: string, entry: BuildCacheEntry): void {
  db.query(
    `INSERT INTO build_cache (branch, slice_signature, content_hash, passed, output, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(branch, slice_signature) DO UPDATE SET
       content_hash = excluded.content_hash, passed = excluded.passed, output = excluded.output, updated_at = datetime('now')`,
  ).run(branch, sliceSignature, entry.contentHash, entry.passed ? 1 : 0, entry.output);
}

export function recordTiming(
  db: Database,
  branch: string,
  command: "plan" | "verify",
  hunkCount: number,
  sliceCount: number,
  durationMs: number,
): void {
  db.query(
    "INSERT INTO timing_runs (branch, command, hunk_count, slice_count, duration_ms) VALUES (?, ?, ?, ?, ?)",
  ).run(branch, command, hunkCount, sliceCount, durationMs);
}
