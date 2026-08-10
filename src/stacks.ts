import { ghAddToStack, ghCreateStack, ghListStacks, ghPrView, ghStackExtensionAvailable, ghStackLink, type GhStack, type PrRef } from "./github";
import type { Correspondence } from "./store";

// GitHub stacks (docs/adr/0030).
//
// drip already produces the thing a GitHub stack groups: an ordered chain of
// PRs, each based on the head branch of the one below it. This module is the
// join between that and GitHub's stack object — deriving the chains from what
// drip actually pushed, deciding what to link, and reporting where drip's idea
// of the chain and GitHub's stack disagree.
//
// The hard constraint the whole module is shaped around: **a GitHub stack is
// strictly linear** — one parent, at most one child. drip's projection graph is
// a DAG. Under `--projection stacked` it is already a single chain and maps
// exactly; under `flat-first` it generally doesn't, and the difference is
// reported rather than resolved by picking a branch of the fork, since which
// dependent "continues the stack" is a review decision no graph can settle.

/** A pushed PR, as the chain derivation sees it. */
export type StackNode = {
  /** the unit's own id — a projection id, or a slice label for atomic slices */
  id: string;
  branch: string;
  prNumber: number;
  /** the ref this PR targets */
  base: string;
  /** bound by `manifest adopt` — someone else's PR, whose base drip may not change */
  adopted: boolean;
};

export type StackChain = {
  /** bottom to top, which is the order GitHub's API wants */
  members: StackNode[];
  /** what the bottom of the chain targets — the trunk, in gh-stack's language */
  base: string;
  /**
   * Set when the chain stops at a PR that several others are based on. The
   * chain up to that point is unambiguous and linkable; which dependent
   * continues it is not, so none of them do.
   */
  forkedAt: { id: string; dependents: string[] } | null;
};

export type ChainDecomposition = {
  chains: StackChain[];
  /**
   * Units that end up alone in their chain. A stack needs two PRs, so a lone
   * PR is not a stack — reported rather than silently dropped, because "why
   * isn't my PR in the stack" is otherwise unanswerable.
   */
  solitary: Array<{ node: StackNode; reason: string }>;
};

/**
 * Decomposes pushed PRs into the maximal linear chains GitHub can express.
 *
 * The edge relation is the one GitHub itself validates: a PR is the parent of
 * another when its head branch is that other PR's base. Deriving it from the
 * bases drip actually set — rather than from the slice DAG — means a chain
 * reported here is a chain GitHub will accept, including the cases where the
 * two disagree (a squash-merged projection dropped out, a base widened, an
 * adopted PR kept a base drip didn't choose).
 */
export function linearChains(nodes: StackNode[]): ChainDecomposition {
  const byBranch = new Map(nodes.map((n) => [n.branch, n]));
  const children = new Map<string, StackNode[]>();
  const roots: StackNode[] = [];
  for (const n of nodes) {
    const parent = byBranch.get(n.base);
    // A PR whose base is not another pushed PR's branch is a root: it targets
    // the base branch, or a generated integration branch that has no PR of its
    // own (push already flags that one — see `hiddenBase`).
    if (!parent || parent.branch === n.branch) roots.push(n);
    else children.set(parent.branch, [...(children.get(parent.branch) ?? []), n]);
  }

  const chains: StackChain[] = [];
  const solitary: ChainDecomposition["solitary"] = [];
  const placed = new Set<string>();
  for (const root of roots) {
    const members = [root];
    placed.add(root.branch);
    let forkedAt: StackChain["forkedAt"] = null;
    for (;;) {
      const next = children.get(members[members.length - 1]!.branch) ?? [];
      if (next.length === 0) break;
      if (next.length > 1) {
        forkedAt = { id: members[members.length - 1]!.id, dependents: next.map((n) => n.id).sort() };
        break;
      }
      // A base relation that came back on itself would otherwise walk forever.
      // It shouldn't happen — drip's bases come from a DAG — but "shouldn't"
      // isn't a reason to hang on someone's malformed correspondence.
      if (placed.has(next[0]!.branch)) break;
      members.push(next[0]!);
      placed.add(next[0]!.branch);
    }
    if (members.length < 2) {
      solitary.push({
        node: root,
        reason: forkedAt
          ? `${forkedAt.dependents.join(", ")} are all based on it, and a GitHub stack is strictly linear`
          : "nothing is based on it and it isn't based on another PR in this push",
      });
      placed.delete(root.branch);
      continue;
    }
    chains.push({ members, base: root.base, forkedAt });
  }

  // Everything a chain didn't reach: the PRs above a fork, and anything in a
  // base cycle. They have a PR and a base and are simply not in any stack —
  // which has to be said, since the alternative is a PR that appears in no
  // line of the report at all.
  for (const n of nodes) {
    if (placed.has(n.branch) || solitary.some((s) => s.node.branch === n.branch)) continue;
    const parent = byBranch.get(n.base);
    const siblings = (children.get(n.base) ?? []).filter((c) => c.branch !== n.branch);
    solitary.push({
      node: n,
      reason: siblings.length
        ? `it and ${siblings.map((s) => s.id).join(", ")} are all based on ${parent!.id}, and a GitHub stack is strictly linear`
        : `it sits above a chain that couldn't be followed from a root (base: ${n.base})`,
    });
  }
  return { chains, solitary };
}

export type StackLinkStatus =
  /** no stack held any of these PRs; one was created */
  | "created"
  /** a stack held a prefix of the chain; the rest was appended */
  | "extended"
  /** GitHub's stack already holds exactly this chain */
  | "unchanged"
  /** GitHub's stack and drip's chain disagree in a way `add` can't fix */
  | "diverged"
  /** planned only — nothing was read from or written to GitHub */
  | "dry-run";

export type StackLinkResult = {
  chain: StackChain;
  status: StackLinkStatus;
  stackNumber: number | null;
  stackUrl: string | null;
  /** the PRs this run appended, empty unless status is "created" or "extended" */
  added: number[];
  /** which command did the grouping; null when nothing was written */
  via: LinkVia | null;
  note: string | null;
};

/** The open members of a stack, bottom to top — a merged PR stays in the stack forever. */
const openMembers = (stack: GhStack): number[] => stack.prs.filter((p) => !p.merged && p.state !== "closed").map((p) => p.number);

const isPrefix = (prefix: number[], full: number[]) => prefix.length <= full.length && prefix.every((n, i) => n === full[i]);

/**
 * Decides what linking a chain requires, given every stack GitHub currently
 * holds. Pure, so the four outcomes are testable without a network: the
 * decision is the part worth being sure about, and `linkStacks` below is then
 * only the two API calls it names.
 */
export function planStackLink(chain: StackChain, stacks: GhStack[]): Omit<StackLinkResult, "chain" | "via"> {
  const wanted = chain.members.map((m) => m.prNumber);
  const holding = stacks.filter((s) => s.prs.some((p) => wanted.includes(p.number)));

  if (holding.length === 0) return { status: "created", stackNumber: null, stackUrl: null, added: wanted, note: null };

  if (holding.length > 1) {
    return {
      status: "diverged",
      stackNumber: null,
      stackUrl: null,
      added: [],
      note:
        `these PRs are spread across stacks ${holding.map((s) => `#${s.number}`).join(", ")} — drip won't merge two stacks, ` +
        "since the stacks API only ever adds. Unstack all but one (`gh stack unstack <number>`) and re-run.",
    };
  }

  const stack = holding[0]!;
  const open = openMembers(stack);
  if (isPrefix(wanted, open)) {
    // Every wanted PR is already in place. A stack holding *more* open PRs on
    // top isn't a disagreement: they're somebody's PRs that drip doesn't
    // manage, and the additive API has no opinion about them either.
    return {
      status: "unchanged",
      stackNumber: stack.number,
      stackUrl: stack.url,
      added: [],
      note:
        open.length > wanted.length
          ? `stack #${stack.number} also holds ${open.slice(wanted.length).map((n) => `#${n}`).join(", ")}, which drip didn't push and doesn't touch`
          : null,
    };
  }
  if (isPrefix(open, wanted)) {
    const added = wanted.slice(open.length);
    return { status: "extended", stackNumber: stack.number, stackUrl: stack.url, added, note: null };
  }
  return {
    status: "diverged",
    stackNumber: stack.number,
    stackUrl: stack.url,
    added: [],
    note:
      `stack #${stack.number} holds ${open.map((n) => `#${n}`).join(", ") || "(nothing open)"} but drip's chain is ` +
      `${wanted.map((n) => `#${n}`).join(", ")} — the stacks API only appends, so drip can't reorder or remove a member. ` +
      "Unstack it (`gh stack unstack " + stack.number + "`) and re-run to recreate it from drip's chain.",
  };
}

/** Injected so the read-only and dry-run paths can be asserted without a `gh` binary. */
export type StacksApi = {
  list: (repoRoot: string) => GhStack[];
  create: (repoRoot: string, prNumbers: number[]) => GhStack;
  add: (repoRoot: string, stackNumber: number, prNumbers: number[]) => GhStack;
  /** is the `gh stack` extension installed — i.e. is the conventional path open */
  extensionAvailable: (repoRoot: string) => boolean;
  /** `gh stack link`: GitHub's own command for grouping PRs a tool already owns */
  link: (opts: { repoRoot: string; base: string; prNumbers: number[]; remote?: string }) => void;
  /** live PR read, used only to protect an adopted PR's base (see `linkStacks`) */
  readPr: (repoRoot: string, prNumber: number) => PrRef;
};

export const realStacksApi: StacksApi = {
  list: ghListStacks,
  create: ghCreateStack,
  add: ghAddToStack,
  extensionAvailable: ghStackExtensionAvailable,
  link: ghStackLink,
  readPr: ghPrView,
};

/** Which command actually did the grouping — reported, because the two differ in what they'd do. */
export type LinkVia = "gh stack link" | "stacks API";

/**
 * An adopted PR's base is a review decision someone else made: drip reports a
 * disagreement and never changes it (docs/adr/0020). `gh stack link` doesn't
 * know that, and retargets any PR whose base isn't its position in the chain.
 *
 * On a chain drip derived that path cannot fire — the chain *is* the bases,
 * member by member, so every expected base equals the current one. The gap is
 * time: the chain comes from correspondence, and an adopted PR may have been
 * retargeted on GitHub since drip recorded it. So before handing a chain to
 * `link`, the live base of each adopted member is checked against the one the
 * chain assumes. A disagreement means `link` *would* retarget it, so drip
 * doesn't call it — and says which PR and which two bases.
 */
function adoptedBaseConflict(chain: StackChain, repoRoot: string, readPr: StacksApi["readPr"]): string | null {
  for (const member of chain.members) {
    if (!member.adopted) continue;
    let live: PrRef;
    try {
      live = readPr(repoRoot, member.prNumber);
    } catch (e) {
      return `could not read adopted PR #${member.prNumber} to check its base before linking (${e instanceof Error ? e.message : String(e)})`;
    }
    if (live.baseRefName && live.baseRefName !== member.base) {
      return (
        `adopted PR #${member.prNumber} targets ${live.baseRefName} on GitHub, but this chain has it on ${member.base} — ` +
        "`gh stack link` would retarget it, and drip does not retarget an adopted PR. Re-run `drip manifest adopt` to re-bind it, " +
        "or link this chain after fixing the base on the PR."
      );
    }
  }
  return null;
}

/**
 * Links each chain into a stack on GitHub.
 *
 * The write goes through **`gh stack link`** whenever the extension is
 * installed — GitHub's own command for the exact case drip is in, branches
 * owned by another tool, no local tracking written. The REST endpoints are the
 * fallback for a machine without the extension, so linking never depends on an
 * install drip can't make. Which path ran is reported either way.
 *
 * One list read serves the whole run: it decides created/extended/unchanged/
 * diverged before anything is written, so an already-correct stack costs no
 * call at all and a divergence is refused rather than half-applied.
 *
 * `dryRun` is read-free on purpose: it reports the chains it would link and
 * says GitHub wasn't consulted, rather than previewing a `created` that a live
 * read might have turned into `unchanged`. That matches what `push --dry-run`
 * already promises about the remote.
 */
export function linkStacks(opts: {
  repoRoot: string;
  chains: StackChain[];
  dryRun: boolean;
  remote?: string;
  api?: StacksApi;
}): StackLinkResult[] {
  const { repoRoot, chains, dryRun } = opts;
  const api = opts.api ?? realStacksApi;
  if (dryRun) {
    return chains.map((chain) => ({
      chain,
      status: "dry-run" as const,
      stackNumber: null,
      stackUrl: null,
      added: [],
      via: null,
      note: "GitHub was not read: whether this chain is already a stack is decided on the real run",
    }));
  }

  const useExtension = api.extensionAvailable(repoRoot);
  let stacks = api.list(repoRoot);
  const results: StackLinkResult[] = [];
  for (const chain of chains) {
    const planned = planStackLink(chain, stacks);
    if (planned.status !== "created" && planned.status !== "extended") {
      results.push({ chain, ...planned, via: null });
      continue;
    }

    if (useExtension) {
      // `gh stack link` is additive and idempotent over the whole chain, so
      // `created` and `extended` are the same call: hand it the chain and let
      // GitHub's own command reconcile. Only the adopted-base guard stands
      // between drip and delegating entirely.
      const conflict = adoptedBaseConflict(chain, repoRoot, api.readPr);
      if (conflict) {
        results.push({ chain, status: "diverged", stackNumber: planned.stackNumber, stackUrl: planned.stackUrl, added: [], via: null, note: conflict });
        continue;
      }
      api.link({ repoRoot, base: chain.base, prNumbers: chain.members.map((m) => m.prNumber), remote: opts.remote });
      // Read back rather than parse `link`'s human output: the stack number is
      // what every later line of the report (and `gh stack merge`) needs.
      stacks = api.list(repoRoot);
      const now = stacks.find((st) => chain.members.every((m) => st.prs.some((p) => p.number === m.prNumber))) ?? null;
      results.push({
        chain,
        ...planned,
        stackNumber: now?.number ?? planned.stackNumber,
        stackUrl: now?.url ?? planned.stackUrl,
        via: "gh stack link",
      });
      continue;
    }

    if (planned.status === "created") {
      const created = api.create(repoRoot, chain.members.map((m) => m.prNumber));
      results.push({ chain, ...planned, stackNumber: created.number, stackUrl: created.url, via: "stacks API" });
      stacks.push(created);
    } else {
      const updated = api.add(repoRoot, planned.stackNumber!, planned.added);
      results.push({ chain, ...planned, stackNumber: updated.number, stackUrl: updated.url, via: "stacks API" });
      const at = stacks.findIndex((st) => st.number === updated.number);
      if (at >= 0) stacks[at] = updated;
    }
  }
  return results;
}

/**
 * The units drip has actually pushed for this branch, as chain nodes.
 *
 * Read from correspondence rather than from a fresh plan on purpose: a stack
 * groups PRs that exist, and correspondence is the record of what drip put on
 * GitHub and what base it targeted. A replan can move the boundaries
 * underneath — that drift is `drip review-context`'s subject, and answering
 * "which PRs are chained right now" shouldn't require re-deriving it.
 */
export function nodesFromCorrespondence(rows: Correspondence[]): { nodes: StackNode[]; unpushed: Correspondence[] } {
  const nodes: StackNode[] = [];
  const unpushed: Correspondence[] = [];
  for (const row of rows) {
    if (row.prNumber && row.baseRef) {
      // A manifest projection's signature carries its id; an atomic slice's is
      // a content hash, so its branch name is the only label it has.
      const id = row.sliceSignature.startsWith("manifest:")
        ? row.sliceSignature.slice("manifest:".length)
        : (row.sliceBranch.split("/").pop() ?? row.sliceBranch);
      nodes.push({ id, branch: row.sliceBranch, prNumber: row.prNumber, base: row.baseRef, adopted: row.adopted });
    } else {
      unpushed.push(row);
    }
  }
  return { nodes, unpushed };
}

export type StackStatusMember = {
  id: string;
  branch: string;
  prNumber: number;
  adopted: boolean;
  /** where GitHub has this PR, when it's in a stack at all */
  stackNumber: number | null;
  /** 1-based position from the bottom, as GitHub orders the stack */
  position: number | null;
  /** GitHub's own view of the PR, from the stack payload — absent when it isn't in one */
  state: string | null;
  merged: boolean | null;
  draft: boolean | null;
};

export type StackStatusChain = {
  chain: StackChain;
  /** exactly what `drip stack link` would do to this chain, computed the same way */
  planned: Omit<StackLinkResult, "chain" | "via">;
  members: StackStatusMember[];
};

export type StackStatusReport = {
  branch: string;
  /** false when the stacks API couldn't be read at all — the local half is still reported */
  available: boolean;
  unavailableReason: string | null;
  chains: StackStatusChain[];
  solitary: ChainDecomposition["solitary"];
  /** correspondence rows with no PR yet: adopted-but-unpushed, or a failed push */
  withoutPr: Array<{ branch: string; signature: string }>;
};

/**
 * The joined, read-only stack view: what drip pushed, how it chains, and what
 * GitHub has grouped. Nothing here writes — same guarantee `review-context`
 * makes (docs/adr/0027), and the suite asserts it the same way.
 */
export function collectStackStatus(opts: {
  repoRoot: string;
  branch: string;
  correspondence: Correspondence[];
  api?: Pick<StacksApi, "list">;
}): StackStatusReport {
  const api = opts.api ?? realStacksApi;
  const { nodes, unpushed } = nodesFromCorrespondence(opts.correspondence);
  const { chains, solitary } = linearChains(nodes);
  let stacks: GhStack[] = [];
  let available = true;
  let unavailableReason: string | null = null;
  try {
    stacks = api.list(opts.repoRoot);
  } catch (e) {
    available = false;
    unavailableReason = e instanceof Error ? e.message : String(e);
  }

  const placement = new Map<number, { stack: GhStack; index: number; pr: GhStack["prs"][number] }>();
  for (const stack of stacks) {
    stack.prs.forEach((pr, index) => placement.set(pr.number, { stack, index, pr }));
  }

  return {
    branch: opts.branch,
    available,
    unavailableReason,
    chains: chains.map((chain) => ({
      chain,
      // With no live read there is nothing to compare against, so the decision
      // is reported as the dry-run it is rather than as a confident "created".
      planned: available
        ? planStackLink(chain, stacks)
        : { status: "dry-run" as const, stackNumber: null, stackUrl: null, added: [], note: "the stacks API could not be read" },
      members: chain.members.map((m) => {
        const at = placement.get(m.prNumber);
        return {
          id: m.id,
          branch: m.branch,
          prNumber: m.prNumber,
          adopted: m.adopted,
          stackNumber: at ? at.stack.number : null,
          position: at ? at.index + 1 : null,
          state: at ? at.pr.state : null,
          merged: at ? at.pr.merged : null,
          draft: at ? at.pr.draft : null,
        };
      }),
    })),
    solitary,
    withoutPr: unpushed.map((c) => ({ branch: c.sliceBranch, signature: c.sliceSignature })),
  };
}

const PLANNED_TEXT: Record<StackLinkStatus, string> = {
  created: "not a stack on GitHub yet — `drip stack link` would create it",
  extended: "on GitHub, missing its top layers — `drip stack link` would append them",
  unchanged: "grouped on GitHub exactly as drip has it",
  diverged: "GitHub's stack and drip's chain disagree",
  "dry-run": "not compared against GitHub",
};

export function printStackStatus(report: StackStatusReport): void {
  console.log(`STACKS (${report.branch}, ${report.chains.length} chain(s)) — read-only:`);
  if (!report.available) console.log(`  GitHub stack state unavailable — ${report.unavailableReason}`);

  for (const { chain, planned, members } of report.chains) {
    const header = planned.stackNumber ? `stack #${planned.stackNumber}` : "chain";
    console.log(`\n  ${header} — ${PLANNED_TEXT[planned.status]}${planned.stackUrl ? ` ${planned.stackUrl}` : ""}`);
    console.log(`    ${renderChain(chain)}`);
    for (const m of members) {
      const where = m.position ? `layer ${m.position} of stack #${m.stackNumber}` : "not in a stack";
      const state = m.merged ? "merged" : (m.state ?? "state unknown");
      console.log(`    ${m.id} — #${m.prNumber} on ${m.branch} [${m.adopted ? "adopted" : "drip"}] ${state}, ${where}`);
    }
    if (planned.note) console.log(`    ${planned.note}`);
    if (chain.forkedAt) {
      console.log(`    chain stops at ${chain.forkedAt.id}: ${chain.forkedAt.dependents.join(", ")} are all based on it, and a stack is linear`);
    }
    if (planned.stackNumber) {
      // Both from `gh stack`'s own vocabulary: `checkout` is how a stack that
      // lives on GitHub becomes locally navigable (up/down/top/bottom), which
      // is the right way to get that rather than drip writing `.git/gh-stack`
      // behind GitHub's back. See docs/adr/0030.
      console.log(`    work on it locally: gh stack checkout ${planned.stackNumber}`);
      console.log(`    land it with:       gh stack merge ${planned.stackNumber} --yes`);
    }
  }

  for (const s of report.solitary) {
    console.log(`\n  ${s.node.id} — #${s.node.prNumber} is in no chain: ${s.reason}`);
  }
  for (const w of report.withoutPr) {
    console.log(`\n  ${w.branch} has correspondence but no PR recorded — nothing to link`);
  }
  console.log("\nNothing was written: no stack created or changed, no PR touched, no correspondence recorded.");
}

export function stackStatusToJson(report: StackStatusReport): object {
  return {
    branch: report.branch,
    readOnly: true,
    available: report.available,
    unavailableReason: report.unavailableReason,
    chains: report.chains.map(({ chain, planned, members }) => ({
      base: chain.base,
      wouldLink: planned.status,
      stackNumber: planned.stackNumber,
      stackUrl: planned.stackUrl,
      note: planned.note,
      forkedAt: chain.forkedAt,
      members,
    })),
    solitary: report.solitary.map((s) => ({ id: s.node.id, pr: s.node.prNumber, branch: s.node.branch, reason: s.reason })),
    withoutPr: report.withoutPr,
  };
}

/**
 * A chain in `gh stack`'s own notation: trunk first, bottom to top, left to
 * right — `(main) <- auth <- api`. Reading drip's output and `gh stack view`
 * side by side shouldn't need a translation step.
 */
export function renderChain(chain: StackChain): string {
  return [`(${chain.base})`, ...chain.members.map((m) => `${m.id}#${m.prNumber}`)].join(" <- ");
}

export function printStackLinks(results: StackLinkResult[], dryRun: boolean): void {
  console.log(dryRun ? `\nSTACKS (${results.length} chain(s), nothing linked):` : `\nSTACKS (${results.length} chain(s)):`);
  for (const r of results) {
    const label = r.stackNumber ? `stack #${r.stackNumber}` : "stack";
    console.log(`  ${label} [${r.status}]${r.via ? ` via ${r.via}` : ""}: ${renderChain(r.chain)}${r.stackUrl ? ` ${r.stackUrl}` : ""}`);
    if (r.note) console.log(`      ${r.note}`);
    if (r.chain.forkedAt) {
      console.log(
        `      chain stops at ${r.chain.forkedAt.id}: ${r.chain.forkedAt.dependents.join(", ")} are all based on it. ` +
          "A GitHub stack is strictly linear, so none of them were added — merge them into one projection, or push with --projection stacked.",
      );
    }
    if (r.stackNumber) {
      console.log(`      work on it locally: gh stack checkout ${r.stackNumber}`);
      console.log(`      land it with:       gh stack merge ${r.stackNumber} --yes`);
    }
  }
}

export function stackLinksToJson(results: StackLinkResult[]): object[] {
  return results.map((r) => ({
    status: r.status,
    via: r.via,
    stackNumber: r.stackNumber,
    stackUrl: r.stackUrl,
    base: r.chain.base,
    members: r.chain.members.map((m) => ({ id: m.id, branch: m.branch, pr: m.prNumber })),
    added: r.added,
    forkedAt: r.chain.forkedAt,
    note: r.note,
  }));
}
