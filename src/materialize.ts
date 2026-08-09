import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitBackend } from "./git-backend";
import type { FileSection, Hunk } from "./planner";

// The unified-diff text for an arbitrary set of hunks, emitted in the diff's
// own file and hunk order so it always applies as one patch.
export function buildPatch(files: FileSection[], hunkIndices: Set<number>): string {
  let patch = "";
  for (const file of files) {
    const selected = file.hunks.filter((h) => hunkIndices.has(h.index));
    if (!selected.length) continue;
    patch += file.header + selected.map((h) => h.raw).join("");
  }
  return patch;
}

// The unified-diff text for one slice — used both to apply it and (in push.ts)
// as the input to its content hash / squash-merge check.
export function buildSlicePatch(files: FileSection[], slices: Map<string, Hunk[]>, sliceId: string): string {
  return buildPatch(files, new Set(slices.get(sliceId)!.map((h) => h.index)));
}

export type ProjectionMode = "stacked" | "flat-first";

// Applies each slice's hunks cumulatively (in topological order) against a
// scratch index, committing after each slice via commit-tree. Each result
// commit's parent is the previous slice's commit — this chain IS the stack:
// verify's per-slice build check walks it with `git worktree add`, and push
// uses the same chain as the actual branch history for each slice's PR.
export async function materializeSliceCommits(opts: {
  git: GitBackend;
  repoRoot: string;
  mergeBase: string;
  files: FileSection[];
  order: string[];
  slices: Map<string, Hunk[]>;
}): Promise<Array<{ sliceId: string; commit: string }>> {
  const { git, repoRoot, mergeBase, files, order, slices } = opts;
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-materialize-"));
  const indexFile = join(tmpDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const results: Array<{ sliceId: string; commit: string }> = [];
  let parentCommit = mergeBase;

  try {
    git.readTree(mergeBase, repoRoot, env);
    for (const id of order) {
      const patch = buildSlicePatch(files, slices, id);
      if (patch) {
        const patchFile = join(tmpDir, "patch.diff");
        writeFileSync(patchFile, patch);
        git.applyCached(patchFile, repoRoot, env);
      }
      const tree = git.writeTree(repoRoot, env);
      const commit = git.commitTree(tree, [parentCommit], `drip: ${id}`, repoRoot);
      parentCommit = commit;
      results.push({ sliceId: id, commit });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return results;
}

// --- flat-first projection (issue #6) ---------------------------------------
//
// The stacked chain above makes every slice depend on every earlier slice,
// even when the DAG says they're independent. Flat-first instead builds each
// slice's branch on top of *only* its transitive prerequisites, so a root
// slice's branch is mergeBase + itself and its PR can target the base branch
// directly.

export type FlatFirstSlice = {
  sliceId: string;
  /** null when the slice couldn't be applied on its prerequisites alone. */
  commit: string | null;
  /** the slice whose branch this PR targets; null means the base branch itself. */
  baseSliceId: string | null;
  /** set when the slice has 2+ prerequisites and needs a generated integration base. */
  integrationCommit: string | null;
  /** transitive prerequisites this slice's branch was built on, in topological order. */
  prerequisites: string[];
  /** true when prerequisites had to be widened past the DAG's edges to make the patch apply. */
  widened: boolean;
  applyError: string | null;
};

export async function materializeFlatFirst(opts: {
  git: GitBackend;
  repoRoot: string;
  mergeBase: string;
  files: FileSection[];
  order: string[];
  slices: Map<string, Hunk[]>;
  edges: [string, string][];
  label?: (sliceId: string) => string;
}): Promise<FlatFirstSlice[]> {
  const { git, repoRoot, mergeBase, files, order, slices, edges } = opts;
  const label = opts.label ?? ((id: string) => id);
  const rank = new Map(order.map((id, i) => [id, i]));

  const directDeps = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const [from, to] of edges) {
    const list = directDeps.get(from);
    if (list && !list.includes(to)) list.push(to);
  }

  const filesOf = new Map(order.map((id) => [id, new Set(slices.get(id)!.map((h) => h.file))]));
  const closureOf = new Map<string, string[]>(); // transitive prerequisites, topologically ordered
  const commitOf = new Map<string, string>();

  // Prerequisites are always reported in topological order, so the identity of
  // a prerequisite set (and therefore of a generated integration branch) is
  // deterministic across runs.
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!;
  const closureFrom = (seeds: string[]): string[] => {
    const out = new Set<string>();
    for (const s of seeds) {
      out.add(s);
      for (const c of closureOf.get(s) ?? []) out.add(c);
    }
    return [...out].sort(byRank);
  };

  const tmpDir = mkdtempSync(join(tmpdir(), "drip-flat-first-"));
  const indexFile = join(tmpDir, "index");
  const patchFile = join(tmpDir, "patch.diff");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  const applyOnto = (parent: string, ids: string[]): string => {
    git.readTree(parent, repoRoot, env);
    for (const id of ids) {
      const patch = buildSlicePatch(files, slices, id);
      if (!patch) continue;
      writeFileSync(patchFile, patch);
      git.applyCached(patchFile, repoRoot, env);
    }
    return git.writeTree(repoRoot, env);
  };

  // A prerequisite set that is exactly some existing slice's own branch content
  // ({that slice} ∪ its closure) can reuse that branch as the PR base. Anything
  // else needs an integration branch unioning the prerequisites.
  const reusableBase = (prereqs: string[]): string | null => {
    const top = prereqs[prereqs.length - 1];
    if (!top) return null;
    const content = [...(closureOf.get(top) ?? []), top];
    return content.length === prereqs.length && content.every((id, i) => id === prereqs[i]) ? top : null;
  };

  const results: FlatFirstSlice[] = [];

  try {
    for (const id of order) {
      const build = (prereqs: string[], widened: boolean): FlatFirstSlice => {
        const missing = prereqs.find((p) => !commitOf.has(p));
        if (missing) {
          return { sliceId: id, commit: null, baseSliceId: null, integrationCommit: null, prerequisites: prereqs, widened, applyError: `prerequisite ${label(missing)} could not be materialized` };
        }
        try {
          let parent = mergeBase;
          let baseSliceId: string | null = null;
          let integrationCommit: string | null = null;

          if (prereqs.length) {
            const reuse = reusableBase(prereqs);
            if (reuse) {
              parent = commitOf.get(reuse)!;
              baseSliceId = reuse;
            } else {
              // Parents are the maximal prerequisites — the ones no other
              // prerequisite already contains — so the integration commit reads
              // as a merge of exactly the branches it unions.
              const covered = new Set(prereqs.flatMap((p) => closureOf.get(p) ?? []));
              const parents = prereqs.filter((p) => !covered.has(p)).map((p) => commitOf.get(p)!);
              const tree = applyOnto(mergeBase, prereqs);
              integrationCommit = git.commitTree(tree, parents, `drip: integration base for ${label(id)}`, repoRoot);
              parent = integrationCommit;
            }
          }

          const tree = applyOnto(parent, [id]);
          const commit = git.commitTree(tree, [parent], `drip: ${label(id)}`, repoRoot);
          return { sliceId: id, commit, baseSliceId, integrationCommit, prerequisites: prereqs, widened, applyError: null };
        } catch (e) {
          return { sliceId: id, commit: null, baseSliceId: null, integrationCommit: null, prerequisites: prereqs, widened, applyError: String(e) };
        }
      };

      const dagPrereqs = closureFrom(directDeps.get(id)!);
      let result = build(dagPrereqs, false);

      // A slice can fail to apply on its DAG prerequisites alone and still be
      // fine in the stack: `git apply` needs exact context, so an earlier
      // slice editing nearby lines of the same file is a real prerequisite the
      // symbol graph never saw. Widen once, deterministically, to every earlier
      // slice touching any of this slice's files, and retry.
      if (!result.commit && !result.applyError?.startsWith("prerequisite ")) {
        const mine = filesOf.get(id)!;
        const overlapping = order
          .slice(0, rank.get(id)!)
          .filter((t) => !dagPrereqs.includes(t) && [...filesOf.get(t)!].some((f) => mine.has(f)));
        if (overlapping.length) {
          const widened = build(closureFrom([...dagPrereqs, ...overlapping]), true);
          if (widened.commit) result = widened;
        }
      }

      if (result.commit) commitOf.set(id, result.commit);
      closureOf.set(id, result.prerequisites);
      results.push(result);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return results;
}
