import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { GitBackend } from "./git-backend";
import { gitPath } from "./repo";
import { getVerificationCache, upsertVerificationCache } from "./store";
import { withWorktree } from "./verify";

// Executable manifest verification (issue #10).
//
// A projection's `verification` commands used to be metadata: printed by
// validate-plan, copied into the PR body, never run. But a projection can
// apply cleanly and reconstruct the final tree while still failing its own
// typecheck or targeted test, because it's missing operational glue — a
// generated input, route wiring, a fixture, a config, an import. Applying
// cleanly is not the same as being runnable, and "each PR is independently
// runnable" is the entire promise of a semantic projection.
//
// So the commands run, against exactly the tree the projection's PR would
// show, and a failure is a hard gate on both validate-plan and push.

export type VerificationRun = {
  projection: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  outputPath: string | null;
  durationMs: number;
  cached: boolean;
};

// Where captured output lives. Inside the gitdir, so it's inspectable after
// the run, never committed, and cleaned up with the clone. Reported by path
// rather than dumped in full — a failing test suite's output is not something
// to inline into a CLI report.
function logDir(repoRoot: string, branch: string): string {
  const dir = join(gitPath(repoRoot, "drip/verification"), branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Commands are given a fixed, boring environment so a rerun on the same tree
// produces the same result and the same captured text: CI=1 (test runners key
// watch/interactive behaviour off it) and colour disabled (ANSI escapes in a
// stored log are noise).
function commandEnv(projection: string): NodeJS.ProcessEnv {
  return { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", DRIP_PROJECTION: projection };
}

export function runManifestVerification(opts: {
  git: GitBackend;
  db: Database;
  repoRoot: string;
  branch: string;
  /** the materialized commit whose tree each projection's PR would show */
  commits: Array<{ projection: string; commit: string; commands: string[] }>;
}): VerificationRun[] {
  const { git, db, repoRoot, branch, commits } = opts;
  const runs: VerificationRun[] = [];
  const withCommands = commits.filter((c) => c.commands.length);
  if (!withCommands.length) return runs;

  const dir = logDir(repoRoot, branch);
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-verification-"));

  try {
    // Sequential, unlike the per-slice build check. That one runs a compiler;
    // these run whatever the manifest author wrote — test suites that bind
    // ports, touch a scratch database, or share fixture directories. Running
    // arbitrary user commands concurrently trades a real class of flakiness
    // for wall-clock time. The cache below is what keeps reruns cheap.
    for (const { projection, commit, commands } of withCommands) {
      const treeHash = git.revParse(`${commit}^{tree}`, repoRoot);
      const pending = commands.filter((command) => {
        const cached = getVerificationCache(db, branch, projection, command);
        // Only a *pass* on this exact tree is reusable. A failure re-runs, so
        // the reported output is always from this run — same convention as the
        // build cache (docs/adr/0008).
        if (!cached || !cached.passed || cached.treeHash !== treeHash) return true;
        runs.push({ projection, command, passed: true, exitCode: 0, outputPath: cached.outputPath, durationMs: cached.durationMs ?? 0, cached: true });
        return false;
      });
      if (!pending.length) continue;

      withWorktree({ git, repoRoot, worktreePath: join(tmpDir, `wt-${runs.length}-${projection}`), commit }, (cwd) => {
        for (const command of pending) {
          const started = Date.now();
          let passed = true;
          let exitCode: number | null = 0;
          let output = "";
          try {
            output = execSync(command, { cwd, stdio: "pipe", env: commandEnv(projection) }).toString();
          } catch (e: any) {
            passed = false;
            exitCode = typeof e.status === "number" ? e.status : null;
            output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") || String(e.message ?? e);
          }
          const durationMs = Date.now() - started;
          const outputPath = join(dir, `${projection}-${commands.indexOf(command)}.log`);
          writeFileSync(outputPath, `$ ${command}\n# tree ${treeHash}\n# exit ${exitCode}\n\n${output}`);
          upsertVerificationCache(db, branch, projection, command, { treeHash, passed, exitCode, outputPath, durationMs });
          runs.push({ projection, command, passed, exitCode, outputPath, durationMs, cached: false });
          // Stop this projection at its first failure: later commands in the
          // same list usually presuppose the earlier ones passed, so running
          // them produces cascading noise rather than new information.
          if (!passed) break;
        }
      });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return runs;
}
