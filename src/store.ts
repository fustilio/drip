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
  return db;
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
