import { expect, mock, test } from "bun:test";
import type { GhStack } from "./github";
import { collectStackStatus, linearChains, linkStacks, nodesFromCorrespondence, planStackLink, type StackChain, type StackNode } from "./stacks";
import type { Correspondence } from "./store";

const node = (id: string, prNumber: number, base: string): StackNode => ({ id, branch: `drip/mega/${id}`, prNumber, base });

const stack = (number: number, prs: Array<[number, { merged?: boolean; closed?: boolean }?]>): GhStack => ({
  number,
  url: `https://example.com/stacks/${number}`,
  base: "main",
  open: true,
  prs: prs.map(([n, opts]) => ({ number: n, state: opts?.closed ? "closed" : "open", draft: false, merged: !!opts?.merged, headRef: "" })),
});

const chainOf = (...nodes: StackNode[]): StackChain => ({ members: nodes, base: nodes[0]!.base, forkedAt: null });

// --- Chain derivation: the edge relation is "this PR's base is that PR's
// branch", which is the same one GitHub validates when a stack is created.

test("a stacked push is one chain, bottom to top", () => {
  const { chains, solitary } = linearChains([
    node("a", 1, "main"),
    node("b", 2, "drip/mega/a"),
    node("c", 3, "drip/mega/b"),
  ]);
  expect(solitary).toEqual([]);
  expect(chains).toHaveLength(1);
  expect(chains[0]!.members.map((m) => m.id)).toEqual(["a", "b", "c"]);
  expect(chains[0]!.base).toBe("main");
  expect(chains[0]!.forkedAt).toBeNull();
});

test("two independent roots are two chains, not one", () => {
  const { chains } = linearChains([
    node("a", 1, "main"),
    node("b", 2, "drip/mega/a"),
    node("x", 3, "main"),
    node("y", 4, "drip/mega/x"),
  ]);
  expect(chains.map((c) => c.members.map((m) => m.id))).toEqual([
    ["a", "b"],
    ["x", "y"],
  ]);
});

test("a fan-out truncates the chain and names the dependents, since a GitHub stack is linear", () => {
  const { chains } = linearChains([
    node("base", 1, "main"),
    node("mid", 2, "drip/mega/base"),
    node("left", 3, "drip/mega/mid"),
    node("right", 4, "drip/mega/mid"),
  ]);
  expect(chains).toHaveLength(1);
  expect(chains[0]!.members.map((m) => m.id)).toEqual(["base", "mid"]);
  expect(chains[0]!.forkedAt).toEqual({ id: "mid", dependents: ["left", "right"] });
});

test("the PRs above a fork are reported as unlinked, never silently dropped", () => {
  const { solitary } = linearChains([
    node("base", 1, "main"),
    node("mid", 2, "drip/mega/base"),
    node("left", 3, "drip/mega/mid"),
    node("right", 4, "drip/mega/mid"),
  ]);
  expect(solitary.map((s) => s.node.id).sort()).toEqual(["left", "right"]);
  expect(solitary.find((s) => s.node.id === "left")!.reason).toContain("right");
});

test("a base cycle terminates instead of walking forever", () => {
  // Not reachable through drip's own DAG, but correspondence is a file on disk.
  const { chains, solitary } = linearChains([node("a", 1, "drip/mega/b"), node("b", 2, "drip/mega/a")]);
  expect(chains).toEqual([]);
  expect(solitary.map((s) => s.node.id).sort()).toEqual(["a", "b"]);
});

test("a lone PR is not a stack, and says why", () => {
  const { chains, solitary } = linearChains([node("only", 1, "main")]);
  expect(chains).toEqual([]);
  expect(solitary).toHaveLength(1);
  expect(solitary[0]!.reason).toContain("nothing is based on it");
});

test("a PR based on a generated integration branch starts a new chain", () => {
  // The integration branch has no PR, so it can't be a stack member — the
  // dependent is a root, exactly as push already flags it (hiddenBase).
  const { chains, solitary } = linearChains([
    node("a", 1, "main"),
    node("b", 2, "main"),
    node("c", 3, "drip/mega/c-base"),
  ]);
  expect(chains).toEqual([]);
  expect(solitary.map((s) => s.node.id).sort()).toEqual(["a", "b", "c"]);
});

// --- Link planning: the four outcomes, decided without a network.

test("no stack holds these PRs -> create", () => {
  const planned = planStackLink(chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a")), []);
  expect(planned.status).toBe("created");
  expect(planned.added).toEqual([1, 2]);
});

test("the stack already holds exactly this chain -> unchanged, nothing added", () => {
  const planned = planStackLink(chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a")), [stack(7, [[1], [2]])]);
  expect(planned.status).toBe("unchanged");
  expect(planned.stackNumber).toBe(7);
  expect(planned.added).toEqual([]);
});

test("the stack holds a prefix -> extend with only the missing top layers", () => {
  const chain = chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"), node("c", 3, "drip/mega/b"));
  const planned = planStackLink(chain, [stack(7, [[1], [2]])]);
  expect(planned.status).toBe("extended");
  expect(planned.added).toEqual([3]);
});

test("a merged member doesn't make the stack look diverged", () => {
  // A merged PR stays in the stack forever; drip's chain no longer carries it
  // because push dropped the squash-merged projection. Comparing against the
  // open members is what keeps the second lap from reporting a false conflict.
  const chain = chainOf(node("b", 2, "main"), node("c", 3, "drip/mega/b"));
  const planned = planStackLink(chain, [stack(7, [[1, { merged: true }], [2], [3]])]);
  expect(planned.status).toBe("unchanged");
});

test("a different order on GitHub -> diverged, and drip does not restructure it", () => {
  const chain = chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"));
  const planned = planStackLink(chain, [stack(7, [[2], [1]])]);
  expect(planned.status).toBe("diverged");
  expect(planned.added).toEqual([]);
  expect(planned.note).toContain("unstack");
});

test("PRs spread across two stacks -> diverged, since the API only ever adds", () => {
  const chain = chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"));
  const planned = planStackLink(chain, [stack(7, [[1]]), stack(8, [[2]])]);
  expect(planned.status).toBe("diverged");
  expect(planned.note).toContain("#7");
  expect(planned.note).toContain("#8");
});

test("extra PRs above drip's chain are left alone, not treated as a conflict", () => {
  const chain = chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"));
  const planned = planStackLink(chain, [stack(7, [[1], [2], [99]])]);
  expect(planned.status).toBe("unchanged");
  expect(planned.note).toContain("#99");
});

// --- The write path: one list read, then at most one write per chain.

test("linkStacks creates once and reports the new stack number", () => {
  const api = {
    list: mock(() => [] as GhStack[]),
    create: mock((_r: string, prs: number[]) => stack(12, prs.map((n) => [n] as [number]))),
    add: mock(() => stack(12, [])),
  };
  const results = linkStacks({
    repoRoot: "/repo",
    chains: [chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"))],
    dryRun: false,
    api,
  });
  expect(api.list).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.add).not.toHaveBeenCalled();
  expect(results[0]!.status).toBe("created");
  expect(results[0]!.stackNumber).toBe(12);
});

test("linkStacks extends an existing stack instead of creating a second one", () => {
  const api = {
    list: mock(() => [stack(7, [[1], [2]])]),
    create: mock(() => stack(0, [])),
    add: mock((_r: string, n: number, prs: number[]) => stack(n, [[1], [2], ...prs.map((p) => [p] as [number])])),
  };
  const results = linkStacks({
    repoRoot: "/repo",
    chains: [chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"), node("c", 3, "drip/mega/b"))],
    dryRun: false,
    api,
  });
  expect(api.create).not.toHaveBeenCalled();
  expect(api.add).toHaveBeenCalledWith("/repo", 7, [3]);
  expect(results[0]!.status).toBe("extended");
});

test("a diverged chain writes nothing at all", () => {
  const api = {
    list: mock(() => [stack(7, [[2], [1]])]),
    create: mock(() => stack(0, [])),
    add: mock(() => stack(7, [])),
  };
  const results = linkStacks({
    repoRoot: "/repo",
    chains: [chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"))],
    dryRun: false,
    api,
  });
  expect(api.create).not.toHaveBeenCalled();
  expect(api.add).not.toHaveBeenCalled();
  expect(results[0]!.status).toBe("diverged");
});

test("dry-run reads nothing and writes nothing", () => {
  const api = {
    list: mock(() => [] as GhStack[]),
    create: mock(() => stack(0, [])),
    add: mock(() => stack(0, [])),
  };
  const results = linkStacks({
    repoRoot: "/repo",
    chains: [chainOf(node("a", 1, "main"), node("b", 2, "drip/mega/a"))],
    dryRun: true,
    api,
  });
  expect(api.list).not.toHaveBeenCalled();
  expect(api.create).not.toHaveBeenCalled();
  expect(results[0]!.status).toBe("dry-run");
  expect(results[0]!.note).toContain("not read");
});

// --- Reading correspondence, and the read-only status view.

const row = (over: Partial<Correspondence>): Correspondence => ({
  branch: "mega",
  sliceSignature: "manifest:a",
  sliceBranch: "drip/mega/a",
  prNumber: 1,
  prUrl: null,
  contentHash: null,
  commitSha: null,
  baseRef: "main",
  adopted: false,
  ...over,
});

test("a manifest projection keeps its id as its label; an atomic slice falls back to its branch", () => {
  const { nodes } = nodesFromCorrespondence([
    row({ sliceSignature: "manifest:report-tab", sliceBranch: "drip/mega/report-tab" }),
    row({ sliceSignature: "9f2c1a", sliceBranch: "drip/mega/slice3", prNumber: 2, baseRef: "drip/mega/report-tab" }),
  ]);
  expect(nodes.map((n) => n.id)).toEqual(["report-tab", "slice3"]);
});

test("correspondence without a PR is separated out rather than becoming a chain node", () => {
  const { nodes, unpushed } = nodesFromCorrespondence([row({ prNumber: null }), row({ prNumber: 2, baseRef: null })]);
  expect(nodes).toEqual([]);
  expect(unpushed).toHaveLength(2);
});

test("stack status joins drip's chain with GitHub's placement, and writes nothing", () => {
  const api = { list: mock(() => [stack(7, [[1], [2]])]) };
  const report = collectStackStatus({
    repoRoot: "/repo",
    branch: "mega",
    correspondence: [
      row({ sliceSignature: "manifest:a", sliceBranch: "drip/mega/a", prNumber: 1, baseRef: "main" }),
      row({ sliceSignature: "manifest:b", sliceBranch: "drip/mega/b", prNumber: 2, baseRef: "drip/mega/a", adopted: true }),
    ],
    api,
  });
  expect(report.available).toBe(true);
  expect(report.chains).toHaveLength(1);
  expect(report.chains[0]!.planned.status).toBe("unchanged");
  expect(report.chains[0]!.members.map((m) => [m.id, m.position, m.stackNumber, m.adopted])).toEqual([
    ["a", 1, 7, false],
    ["b", 2, 7, true],
  ]);
});

test("an unreadable stacks API degrades to 'not compared' instead of claiming the stack is missing", () => {
  const api = {
    list: mock(() => {
      throw new Error("stacked pull requests are not enabled here");
    }),
  };
  const report = collectStackStatus({
    repoRoot: "/repo",
    branch: "mega",
    correspondence: [row({ sliceSignature: "manifest:a", prNumber: 1, baseRef: "main" }), row({ sliceSignature: "manifest:b", sliceBranch: "drip/mega/b", prNumber: 2, baseRef: "drip/mega/a" })],
    api,
  });
  expect(report.available).toBe(false);
  expect(report.unavailableReason).toContain("not enabled");
  expect(report.chains[0]!.planned.status).toBe("dry-run");
  expect(report.chains[0]!.members.every((m) => m.stackNumber === null)).toBe(true);
});
