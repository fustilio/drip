import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { listProjectionCorrespondence, type Adoption } from "./adopt";
import { DripError } from "./errors";
import type { GitBackend } from "./git-backend";
import type { ResolvedManifest } from "./manifest";
import { materializeFlatFirst, materializeSliceCommits, type ProjectionMode } from "./materialize";
import type { PlanResult } from "./planner";
import { dripBranchName } from "./push";

// Local materialization of a validated manifest (issue #13).
//
// Until now the only code path that produced a projection's actual commits was
// `push`, which force-pushes branch heads and opens PRs in the same breath.
// That is far too late to *look* at a projection — which is exactly what a team
// splitting an integration branch into a hand-reviewed PR set needs to do
// first, especially when a projection overlaps a handwritten branch that
// already has reviewers on it.
//
// So: the same materialization, stopping at the local repository. Refs and
// optional worktrees, no remote, no `gh`, nothing recorded in correspondence.
// The operator diffs, reconciles, adopts or force-pushes afterwards — with the
// manifest-to-branch correspondence that a disposable clone and a handful of
// `gh` invocations would have thrown away.

export type LocalStatus = "created" | "updated" | "unchanged" | "blocked";

export type MaterializedProjection = {
  projectionId: string;
  /** false when this projection is here only because something selected needs it */
  selected: boolean;
  /** the local ref this projection was written to */
  ref: string;
  /** what the ref is built on: the base branch, a prerequisite's ref, or a generated integration ref */
  base: string;
  integrationRef: string | null;
  commit: string | null;
  tree: string | null;
  prerequisites: string[];
  widened: boolean;
  files: string[];
  hunkCount: number;
  changedLines: number;
  status: LocalStatus;
  /** path of the checked-out worktree, when --output asked for one */
  worktree: string | null;
  /** the PR this projection is already bound to — adopted or drip-opened */
  correspondence: Adoption | null;
  note: string | null;
};

export type MaterializeResult = {
  branch: string;
  mode: ProjectionMode;
  outputDir: string | null;
  projections: MaterializedProjection[];
  warnings: string[];
  ok: boolean;
};

const note = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join("; ") || null;

export async function materializeProjections(opts: {
  git: GitBackend;
  db: Database;
  repoRoot: string;
  /** the mega branch this manifest projects */
  branch: string;
  baseBranch: string;
  mergeBase: string;
  plan: PlanResult;
  resolved: ResolvedManifest;
  mode: ProjectionMode;
  /** projection ids to materialize; empty means all of them */
  only?: string[];
  /** directory to check each materialized projection out into */
  outputDir?: string | null;
  /** move a ref that exists with different content, and replace an existing worktree */
  force?: boolean;
}): Promise<MaterializeResult> {
  const { git, db, repoRoot, branch, baseBranch, mergeBase, plan, resolved, mode } = opts;
  const order = resolved.order;
  const force = !!opts.force;
  // Relative to the caller's cwd, like every other path flag — `--repo` names
  // the repository, it doesn't relocate the rest of the command line.
  const outputDir = opts.outputDir ? resolve(opts.outputDir) : null;
  const warnings: string[] = [];
  if (outputDir && (outputDir === repoRoot || outputDir.startsWith(repoRoot + sep))) {
    // Allowed — git permits it and some teams keep worktrees in an ignored
    // directory — but a checkout inside the repo becomes untracked content
    // that the next `--worktree` plan picks up as part of the change.
    warnings.push(`--output ${outputDir} is inside the repository, so these worktrees will show up as untracked content in it`);
  }

  const only = [...new Set(opts.only ?? [])];
  const unknown = only.filter((id) => !order.includes(id));
  if (unknown.length) {
    throw new DripError(`no projection '${unknown.join("', '")}' in this manifest — known ids: ${order.join(", ")}`);
  }

  // Everything is materialized regardless of selection: a selected projection's
  // base is a prerequisite's ref, and in stacked mode its content is the whole
  // prefix. Selection decides which refs and worktrees get *written*, never
  // what the projection is built on — a subset that quietly changed its own
  // base would be materializing something other than what push would send.
  const flatById = new Map<string, Awaited<ReturnType<typeof materializeFlatFirst>>[number]>();
  let commits: Array<{ sliceId: string; commit: string | null }>;
  if (mode === "flat-first") {
    const flat = await materializeFlatFirst({
      git,
      repoRoot,
      mergeBase,
      files: plan.files,
      order,
      slices: resolved.units,
      edges: resolved.edges,
      label: (id) => id,
    });
    for (const f of flat) flatById.set(f.sliceId, f);
    commits = flat;
  } else {
    try {
      commits = await materializeSliceCommits({ git, repoRoot, mergeBase, files: plan.files, order, slices: resolved.units });
    } catch (e) {
      // Unreachable in practice — validation's tree-hash check applies the same
      // patches in the same order first — but a raw `git apply` stack trace is
      // not an error message.
      throw new DripError(`could not materialize the stacked chain: ${String(e)}`);
    }
  }
  const commitOf = new Map(commits.map((c) => [c.sliceId, c.commit]));

  // The selection closure. Flat-first takes the prerequisites each projection
  // was actually built on (declared, plus any widening); stacked has no such
  // thing — its chain makes every earlier projection a real prerequisite of
  // whatever comes after it.
  const wanted = new Set(only.length ? only : order);
  if (only.length) {
    if (mode === "flat-first") {
      for (const id of only) for (const p of flatById.get(id)?.prerequisites ?? []) wanted.add(p);
    } else {
      const last = Math.max(...only.map((id) => order.indexOf(id)));
      for (const id of order.slice(0, last + 1)) wanted.add(id);
    }
  }

  const adoptions = new Map(listProjectionCorrespondence(db, branch).map((a) => [a.projectionId, a]));
  const byId = new Map(resolved.projections.map((p) => [p.id, p]));
  const refOf = (id: string) => dripBranchName(branch, id);

  const treeOf = (commitish: string): string | null => {
    try {
      return git.revParse(`${commitish}^{tree}`, repoRoot);
    } catch {
      return null;
    }
  };

  // Writing one ref, with the only destructive case in the command guarded:
  // a ref that exists and holds different content. Sameness is judged by tree,
  // not by sha — `commit-tree` mints a fresh sha on every run, so comparing
  // shas would make every re-run look like a rewrite and demand --force.
  const writeRef = (name: string, commit: string): { status: LocalStatus; sha: string; note: string | null } => {
    const ref = `refs/heads/${name}`;
    const existingTree = treeOf(ref);
    if (existingTree === null) {
      git.updateRef(ref, commit, repoRoot);
      return { status: "created", sha: commit, note: null };
    }
    if (existingTree === treeOf(commit)) {
      // Same content: leave the ref where it is. Rewriting it would change the
      // sha under anything already looking at it and show nothing new.
      return { status: "unchanged", sha: git.revParse(ref, repoRoot), note: null };
    }
    if (!force) {
      return {
        status: "blocked",
        sha: git.revParse(ref, repoRoot),
        note: `local ref '${name}' already exists with different content — inspect it, then pass --force to move it`,
      };
    }
    git.updateRef(ref, commit, repoRoot);
    return { status: "updated", sha: commit, note: null };
  };

  if (outputDir) mkdirSync(outputDir, { recursive: true });

  const results: MaterializedProjection[] = [];
  for (const id of order) {
    if (!wanted.has(id)) continue;

    const projection = byId.get(id)!;
    const flat = flatById.get(id);
    const commit = commitOf.get(id) ?? null;
    const ref = refOf(id);
    const common = {
      projectionId: id,
      selected: !only.length || only.includes(id),
      ref,
      prerequisites: flat ? flat.prerequisites : order.slice(0, order.indexOf(id)),
      widened: !!flat?.widened,
      files: projection.files,
      hunkCount: projection.hunkCount,
      changedLines: projection.changedLines,
      correspondence: adoptions.get(id) ?? null,
      worktree: null,
    };

    if (!commit) {
      results.push({
        ...common,
        base: baseBranch,
        integrationRef: null,
        commit: null,
        tree: null,
        status: "blocked",
        note: flat?.applyError ?? "could not be materialized",
      });
      continue;
    }

    // The base, computed exactly as push computes it, so what's on disk is what
    // a PR would target — with one deliberate difference: an adopted
    // prerequisite's *local* ref is drip's own, since drip must not write over
    // a local copy of somebody else's branch. The disagreement is reported.
    let base: string;
    let integrationRef: string | null = null;
    let baseNote: string | null = null;
    if (mode === "stacked") {
      const index = order.indexOf(id);
      base = index === 0 ? baseBranch : refOf(order[index - 1]!);
    } else if (flat!.integrationCommit) {
      integrationRef = `${ref}-base`;
      base = integrationRef;
      baseNote = `integration base unions ${flat!.prerequisites.join(", ")}`;
    } else if (flat!.baseSliceId) {
      base = refOf(flat!.baseSliceId);
    } else {
      base = baseBranch;
    }

    if (integrationRef && flat!.integrationCommit) {
      const written = writeRef(integrationRef, flat!.integrationCommit);
      if (written.status === "blocked") {
        results.push({
          ...common,
          base,
          integrationRef,
          commit: null,
          tree: null,
          status: "blocked",
          note: note(baseNote, `its integration base could not be written: ${written.note}`),
        });
        continue;
      }
    }

    const written = writeRef(ref, commit);
    const adoptedPrereqs = common.prerequisites.filter((p) => adoptions.get(p)?.adopted);
    const row: MaterializedProjection = {
      ...common,
      base,
      integrationRef,
      commit: written.sha,
      tree: treeOf(written.sha),
      status: written.status,
      note: note(
        baseNote,
        written.note,
        flat?.widened ? `prerequisites widened past the declared dependsOn: ${flat.prerequisites.join(", ")}` : null,
        adoptedPrereqs.length
          ? `prerequisite ${adoptedPrereqs.join(", ")} is adopted — push would target its own branch, this ref is built on drip's`
          : null,
      ),
    };

    if (outputDir && row.status !== "blocked") {
      const path = join(outputDir, id);
      if (existsSync(path)) {
        if (!force) {
          row.note = note(row.note, `worktree path '${path}' already exists — pass --force to replace it`);
        } else {
          try {
            git.worktreeRemove(path, repoRoot);
          } catch (e) {
            throw new DripError(`could not replace the worktree at ${path}: ${String(e)} — remove it by hand and re-run`);
          }
          git.worktreeAdd(path, written.sha, repoRoot);
          row.worktree = path;
        }
      } else {
        git.worktreeAdd(path, written.sha, repoRoot);
        row.worktree = path;
      }
    }

    results.push(row);
  }

  return { branch, mode, outputDir, projections: results, warnings, ok: !results.some((r) => r.status === "blocked") };
}

export function materializeToJson(result: MaterializeResult): object {
  return {
    ok: result.ok,
    branch: result.branch,
    mode: result.mode,
    outputDir: result.outputDir,
    warnings: result.warnings,
    projections: result.projections.map((p) => ({
      projection: p.projectionId,
      selected: p.selected,
      ref: p.ref,
      base: p.base,
      integrationRef: p.integrationRef,
      commit: p.commit,
      tree: p.tree,
      prerequisites: p.prerequisites,
      widened: p.widened,
      files: p.files,
      hunks: p.hunkCount,
      changedLines: p.changedLines,
      status: p.status,
      worktree: p.worktree,
      correspondence: p.correspondence
        ? { pr: p.correspondence.prNumber, branch: p.correspondence.branch, url: p.correspondence.prUrl, adopted: p.correspondence.adopted }
        : null,
      note: p.note,
    })),
  };
}

/** How many of a projection's files to name before summarising the rest. */
const FILES_SHOWN = 10;

export function printMaterializeReport(result: MaterializeResult): void {
  const selected = result.projections.filter((p) => p.selected).length;
  for (const w of result.warnings) console.log(`note: ${w}`);
  console.log(`MATERIALIZED (${result.mode}, ${selected} selected of ${result.projections.length} written):`);

  for (const p of result.projections) {
    console.log(`  ${p.projectionId} [${p.status}]${p.selected ? "" : " (prerequisite)"}`);
    console.log(`    ref:   ${p.ref}${p.commit ? ` @ ${p.commit.slice(0, 7)}` : ""}`);
    console.log(`    base:  ${p.base}`);
    console.log(`    ${p.files.length} file(s), ${p.hunkCount} hunk(s), ${p.changedLines} changed line(s)`);
    for (const f of p.files.slice(0, FILES_SHOWN)) console.log(`      ${f}`);
    if (p.files.length > FILES_SHOWN) console.log(`      ... (${p.files.length - FILES_SHOWN} more)`);
    if (p.worktree) console.log(`    worktree: ${p.worktree}`);
    if (p.correspondence) {
      const { prNumber, branch, adopted } = p.correspondence;
      const pr = prNumber ? `#${prNumber} ` : "";
      console.log(
        adopted
          ? `    adopted: ${pr}on ${branch} — compare with \`git diff ${p.ref}..${branch}\``
          : `    PR: ${pr}on ${branch}, opened by drip`,
      );
    }
    if (p.note) console.log(`    note: ${p.note}`);
  }

  const counts = (["created", "updated", "unchanged", "blocked"] as const)
    .map((s) => [s, result.projections.filter((p) => p.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  console.log(result.ok ? `\nMATERIALIZE: PASS (${counts})` : `\nMATERIALIZE: FAIL (${counts})`);
  console.log("Nothing was pushed: no remote ref was written, no PR was opened, closed or commented on.");
}
