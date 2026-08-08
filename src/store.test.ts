import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openStore } from "./store";
import { commit, git, makeTempRepo } from "./test-helpers";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("openStore in a linked worktree writes to the worktree's private gitdir, not the main repo's .git", () => {
  const { repoRoot, cleanup: cleanupRepo } = makeTempRepo("drip-store-test-");
  cleanup = cleanupRepo;
  writeFileSync(join(repoRoot, "a.txt"), "x");
  commit(repoRoot, "init");
  git(["branch", "other"], repoRoot);

  const worktreeRoot = `${repoRoot}-worktree`;
  git(["worktree", "add", "-q", worktreeRoot, "other"], repoRoot);
  try {
    using db = openStore(worktreeRoot);
    db.run("SELECT 1");

    expect(existsSync(join(repoRoot, ".git", "drip.db"))).toBe(false);
    expect(existsSync(join(repoRoot, ".git", "worktrees", basename(worktreeRoot), "drip.db"))).toBe(true);
  } finally {
    git(["worktree", "remove", "--force", worktreeRoot], repoRoot);
  }
});
