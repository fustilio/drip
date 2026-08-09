import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

// What this repository offers as a runnable check (issue #14).
//
// drip's per-slice build check defaulted to `tsc --noEmit` if a *root*
// `tsconfig.json` existed and skipped otherwise. In an npm/pnpm/bun workspace
// there usually is no root tsconfig — the tsconfigs live one directory down —
// so the check silently evaporated exactly where it was needed most: a
// mechanically split projection can reconstruct the mega branch's tree
// perfectly and still not typecheck, because the symbols it needs got assigned
// to a different projection.
//
// So drip looks at what the repository itself declares. Two different uses,
// deliberately not the same thing:
//
//   - a *root* command it will run on its own (`rootCommand`), which is only
//     ever something the repo named itself — a root tsconfig, or a root
//     `typecheck` script. drip does not compose one out of package-level
//     pieces: guessing the right invocation for someone's workspace and then
//     failing a push on the result is worse than saying it can't.
//   - per-package commands it *offers* (`packageCommands`), printed so they
//     can be pasted into a projection's `verification`. Never executed by
//     discovery — a manifest command runs because someone declared it
//     (docs/adr/0019).

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type WorkspacePackage = {
  /** repo-relative directory, e.g. "packages/api" */
  dir: string;
  name: string | null;
  /** check-shaped scripts this package declares, in CHECK_SCRIPTS order */
  scripts: string[];
  hasTsconfig: boolean;
};

export type WorkspaceChecks = {
  /** false when there's no root package.json at all — not a JS/TS workspace, so none of this applies */
  isJsWorkspace: boolean;
  packageManager: PackageManager;
  /** a whole-repo command drip is willing to run unprompted, or null */
  rootCommand: { command: string; source: "root-tsconfig" | "root-script" } | null;
  packages: WorkspacePackage[];
  /** ready-to-paste `verification` entries, one per package check */
  packageCommands: string[];
};

/** Scripts worth offering as a projection's verification, most specific first. */
const CHECK_SCRIPTS = ["typecheck", "type-check", "tsc", "lint", "test"];

/** Directories never worth descending into when looking for workspace packages. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "target"]);

/** How deep a workspace package can be nested before drip stops looking. `packages/group/pkg` is 3. */
const MAX_DEPTH = 3;

export const DEFAULT_TSC_CMD = "bunx tsc --noEmit";

// Whether a projection containing this file is "code" for gating purposes.
// Broader than the set the planner can parse (`.mts`/`.cts` have no grammar
// loaded but are still code a typecheck covers) and narrower than "everything"
// — a docs- or lockfile-only projection has nothing to typecheck, so demanding
// a verification command from it would be noise.
const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export const isCodeFile = (path: string): boolean => CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A package.json drip can't read is a package it can't offer commands for.
    // That's a reporting gap, never a reason to fail the run.
    return null;
  }
}

function detectPackageManager(repoRoot: string): PackageManager {
  const lockfiles: Array<[string, PackageManager]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of lockfiles) if (existsSync(join(repoRoot, file))) return pm;
  return "npm";
}

// The invocation that runs one package's script from the repo root. Package
// managers disagree about this and there is no portable form, so it's a small
// table rather than something clever. A package with no name falls back to
// `cd`, which every one of them accepts.
function packageScriptCommand(pm: PackageManager, pkg: WorkspacePackage, script: string): string {
  if (!pkg.name) return `cd ${pkg.dir} && ${pm} run ${script}`;
  switch (pm) {
    case "bun":
      return `bun run --filter ${pkg.name} ${script}`;
    case "pnpm":
      return `pnpm --filter ${pkg.name} ${script}`;
    case "yarn":
      return `yarn workspace ${pkg.name} run ${script}`;
    case "npm":
      return `npm run ${script} --workspace ${pkg.name}`;
  }
}

// Every package.json under the repo root, found by walking rather than by
// expanding the workspace globs. Globs differ per package manager and a repo
// can have packages the root never declared; the directory tree is the same
// for all of them.
function findPackages(repoRoot: string): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];

  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      const manifest = join(child, "package.json");
      if (existsSync(manifest)) {
        const json = readJson(manifest);
        const scripts = (json?.scripts ?? {}) as Record<string, unknown>;
        found.push({
          dir: relative(repoRoot, child).split(sep).join("/"),
          name: typeof json?.name === "string" ? json.name : null,
          scripts: CHECK_SCRIPTS.filter((s) => typeof scripts[s] === "string"),
          hasTsconfig: existsSync(join(child, "tsconfig.json")),
        });
      }
      if (depth < MAX_DEPTH) walk(child, depth + 1);
    }
  };

  walk(repoRoot, 1);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function discoverWorkspaceChecks(repoRoot: string): WorkspaceChecks {
  const packageManager = detectPackageManager(repoRoot);
  const rootPackageJson = readJson(join(repoRoot, "package.json"));
  // Presence, not parseability: a package.json drip can't read is still a JS
  // repo, and the packages under it may be perfectly readable.
  const isJsWorkspace = existsSync(join(repoRoot, "package.json")) || existsSync(join(repoRoot, "tsconfig.json"));

  let rootCommand: WorkspaceChecks["rootCommand"] = null;
  if (existsSync(join(repoRoot, "tsconfig.json"))) {
    rootCommand = { command: DEFAULT_TSC_CMD, source: "root-tsconfig" };
  } else {
    const scripts = (rootPackageJson?.scripts ?? {}) as Record<string, unknown>;
    // Only a script the repo itself calls a typecheck. `test` is not a
    // substitute — running someone's whole suite per slice, unasked, is not a
    // default drip gets to pick.
    const script = ["typecheck", "type-check"].find((s) => typeof scripts[s] === "string");
    if (script) rootCommand = { command: `${packageManager} run ${script}`, source: "root-script" };
  }

  const packages = isJsWorkspace ? findPackages(repoRoot) : [];
  const packageCommands = packages.flatMap((pkg) => pkg.scripts.map((s) => packageScriptCommand(packageManager, pkg, s)));

  return { isJsWorkspace, packageManager, rootCommand, packages, packageCommands };
}

/** How many suggested commands to print before summarising the rest. */
const COMMANDS_SHOWN = 8;

// The advice printed wherever a projection has no runnable check: what this
// repo offers, in a form that can be pasted straight into a manifest.
export function describeWorkspaceChecks(checks: WorkspaceChecks): string[] {
  if (!checks.isJsWorkspace || !checks.packageCommands.length) return [];
  const lines = [
    `${checks.packages.filter((p) => p.scripts.length).length} workspace package(s) declare a check script ` +
      `(${checks.packageManager} detected) — usable as a projection's \`verification\`:`,
  ];
  for (const command of checks.packageCommands.slice(0, COMMANDS_SHOWN)) lines.push(`  ${command}`);
  if (checks.packageCommands.length > COMMANDS_SHOWN) lines.push(`  ... (${checks.packageCommands.length - COMMANDS_SHOWN} more)`);
  return lines;
}
