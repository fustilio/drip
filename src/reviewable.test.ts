import { expect, test } from "bun:test";
import { classifyBaseBranch, describeBase, type BaseBranchFacts } from "./reviewable";

// The whole `--reviewable-stack` base decision, exercised as a table. Every
// read is an input here, so this covers what a push would do without a repo,
// a remote or a GitHub. See docs/adr/0032.

function facts(over: Partial<BaseBranchFacts> = {}): BaseBranchFacts {
  return {
    base: "main",
    remoteHeads: new Map([["main", "aaa"]]),
    refKind: "branch",
    defaultBranch: "main",
    openPrHeads: new Map(),
    ...over,
  };
}

test("the default branch is a reviewable base: it is what PRs are reviewed against", () => {
  const check = classifyBaseBranch(facts(), true);
  expect(check).toMatchObject({ ok: true, review: { kind: "default-branch", branch: "main" } });
});

test("a base branch that is itself under review is fine, and the PR is named", () => {
  const check = classifyBaseBranch(
    facts({ base: "release/2", remoteHeads: new Map([["release/2", "bbb"]]), openPrHeads: new Map([["release/2", 77]]) }),
    true,
  );
  expect(check).toMatchObject({ ok: true, review: { kind: "base-pr", branch: "release/2", prNumber: 77 } });
});

test("a commit sha is refused as a base, and the message says a PR base must be a branch", () => {
  const check = classifyBaseBranch(facts({ base: "9f2c1ab", remoteHeads: new Map(), refKind: "commit" }), true);
  expect(check.ok).toBe(false);
  expect(check.ok === false && check.message).toContain("is a commit, not a branch");
  // The remedy is never "let drip publish a branch for it" — that is the hidden
  // base this flag exists to refuse (issue #14's follow-up).
  expect(check.ok === false && check.message).toContain("drip will not publish a branch for it");
  expect(check.ok === false && check.message).toContain("manifest adopt");
});

test("a tag is refused too — rev-parse resolves it, GitHub won't accept it", () => {
  const check = classifyBaseBranch(facts({ base: "v1.4.0", remoteHeads: new Map(), refKind: "tag" }), true);
  expect(check.ok === false && check.message).toContain("is a tag, not a branch");
});

test("a remote-tracking ref is refused with the branch name to use instead", () => {
  const check = classifyBaseBranch(facts({ base: "origin/main", remoteHeads: new Map([["main", "aaa"]]), refKind: "remote" }), true);
  expect(check.ok === false && check.message).toContain("'main', not 'origin/main'");
});

test("a branch origin doesn't have is refused: GitHub can't target what it can't see", () => {
  const check = classifyBaseBranch(facts({ base: "local-only", remoteHeads: new Map([["main", "aaa"]]), refKind: "branch" }), true);
  expect(check.ok === false && check.message).toContain("git push -u origin local-only");
});

test("a branch nothing reviews is refused — this is the published-stand-in base", () => {
  // The exact shape from issue #14's follow-up: a branch published to point at
  // the commit a prerequisite lives on, so `--base <sha>` would succeed.
  const check = classifyBaseBranch(
    facts({ base: "prereq-tip", remoteHeads: new Map([["prereq-tip", "ccc"]]), openPrHeads: new Map() }),
    true,
  );
  expect(check.ok).toBe(false);
  expect(check.ok === false && check.message).toContain("no open PR of its own");
  expect(check.ok === false && check.message).toContain("isn't this repository's default branch ('main')");
  // Both ways out are named, and neither is a synthetic base branch.
  expect(check.ok === false && check.message).toContain("Target 'main'");
  expect(check.ok === false && check.message).toContain("declare it in the manifest");
});

test("GitHub unreadable: a dry-run says it couldn't confirm, a real push refuses", () => {
  const unreadable = facts({ defaultBranch: null, openPrHeads: null });
  expect(classifyBaseBranch(unreadable, false)).toMatchObject({ ok: true, review: { kind: "unconfirmed", branch: "main" } });

  const strict = classifyBaseBranch(unreadable, true);
  expect(strict.ok).toBe(false);
  expect(strict.ok === false && strict.message).toContain("may not decide a base is reviewable by failing to look");
});

test("an unreadable remote falls back to the clone, rather than refusing everything", () => {
  // A dry-run offline: origin can't be listed, so "is this a branch" is answered
  // locally. A local branch passes; a sha still doesn't.
  expect(classifyBaseBranch(facts({ remoteHeads: null, refKind: "branch" }), false)).toMatchObject({ ok: true });
  const sha = classifyBaseBranch(facts({ base: "9f2c1ab", remoteHeads: null, refKind: "commit" }), false);
  expect(sha.ok).toBe(false);
});

test("a name that is nothing at all reports which places were checked", () => {
  const onRemote = classifyBaseBranch(facts({ base: "typo", remoteHeads: new Map([["main", "a"]]), refKind: "none" }), true);
  expect(onRemote.ok === false && onRemote.message).toContain("not a branch on origin, and names nothing in this clone either");

  const offline = classifyBaseBranch(facts({ base: "typo", remoteHeads: null, refKind: "none" }), true);
  expect(offline.ok === false && offline.message).toContain("origin could not be read");
});

test("describeBase says what makes each base reviewable, not just its name", () => {
  expect(describeBase("main", { kind: "default-branch", branch: "main" })).toBe("main (default branch)");
  expect(describeBase("release/2", { kind: "base-pr", branch: "release/2", prNumber: 77 })).toBe("release/2 (#77)");
  expect(describeBase("drip/f/shared", { kind: "prerequisite", projection: "shared-contract", prNumber: 12 })).toBe(
    "drip/f/shared (shared-contract, #12)",
  );
  // A dry-run hasn't opened the prerequisite's PR yet — the plan still has to
  // say which branch will own it.
  expect(describeBase("drip/f/shared", { kind: "prerequisite", projection: "shared-contract", prNumber: null })).toBe(
    "drip/f/shared (shared-contract, PR opens in this run)",
  );
  expect(describeBase("drip/f/x-base", { kind: "generated" })).toBe("drip/f/x-base (generated, not reviewable on GitHub)");
  expect(describeBase("main", { kind: "unchecked" })).toBe("main");
});
