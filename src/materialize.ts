import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitBackend } from "./git-backend";
import type { FileSection, Hunk } from "./planner";

// The unified-diff text for one slice — used both to apply it and (in push.ts)
// as the input to its content hash / squash-merge check.
export function buildSlicePatch(files: FileSection[], slices: Map<string, Hunk[]>, sliceId: string): string {
  const hunksInSlice = new Set(slices.get(sliceId)!.map((h) => h.index));
  let patch = "";
  for (const file of files) {
    const selected = file.hunks.filter((h) => hunksInSlice.has(h.index));
    if (!selected.length) continue;
    patch += file.header + selected.map((h) => h.raw).join("");
  }
  return patch;
}

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
