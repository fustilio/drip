import { Database } from "bun:sqlite";
import { join } from "node:path";

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
  const db = new Database(join(repoRoot, ".git", "drip.db"), { create: true });
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
  // and commit sha. ALTER TABLE ADD COLUMN has no IF NOT EXISTS — swallow the
  // "duplicate column" error on repos that already have this table.
  for (const col of ["content_hash TEXT", "commit_sha TEXT"]) {
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
  return db;
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
};

export function getCorrespondence(db: Database, branch: string, sliceSignature: string): Correspondence | null {
  const row = db
    .query(
      "SELECT id, branch, slice_signature as sliceSignature, slice_branch as sliceBranch, pr_number as prNumber, pr_url as prUrl, content_hash as contentHash, commit_sha as commitSha FROM correspondence WHERE branch = ? AND slice_signature = ?",
    )
    .get(branch, sliceSignature) as Correspondence | null;
  return row;
}

export function upsertCorrespondence(db: Database, c: Correspondence): void {
  db.query(
    `INSERT INTO correspondence (branch, slice_signature, slice_branch, pr_number, pr_url, content_hash, commit_sha, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(branch, slice_signature) DO UPDATE SET
       slice_branch = excluded.slice_branch,
       pr_number = excluded.pr_number,
       pr_url = excluded.pr_url,
       content_hash = excluded.content_hash,
       commit_sha = excluded.commit_sha,
       updated_at = datetime('now')`,
  ).run(c.branch, c.sliceSignature, c.sliceBranch, c.prNumber, c.prUrl, c.contentHash, c.commitSha);
}

export function deleteCorrespondence(db: Database, branch: string, sliceSignature: string): void {
  db.query("DELETE FROM correspondence WHERE branch = ? AND slice_signature = ?").run(branch, sliceSignature);
}

export function listOverrides(db: Database, branch: string): Override[] {
  const rows = db
    .query("SELECT id, kind, selector_a as selectorA, selector_b as selectorB, note FROM overrides WHERE branch = ?")
    .all(branch) as Override[];
  return rows;
}

export function addOverride(
  db: Database,
  branch: string,
  kind: OverrideKind,
  selectorA: string,
  selectorB: string | null,
  note: string | null,
): void {
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

export function markCommentProcessed(db: Database, prCommentId: number, branch: string, sliceSignature: string, status: "unchanged" | "orphaned"): void {
  db.query(
    "INSERT OR IGNORE INTO comment_anchors (pr_comment_id, branch, slice_signature, status) VALUES (?, ?, ?, ?)",
  ).run(prCommentId, branch, sliceSignature, status);
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
