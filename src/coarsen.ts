import { createHash } from "node:crypto";
import { DripError } from "./errors";
import { groupKeyOf, topoSort, type Hunk, type PlanResult } from "./planner";

// Review-sized coarsening (issue #8). Connected components over symbol edges
// produce technically isolated slices, but a symbol is rarely a PR boundary:
// a real 55-commit branch produced 114 slices whose meaningful review units
// were closer to six areas. This sits *above* the atomic slice DAG — it never
// re-derives, re-splits or reorders hunks, it only decides which atomic slices
// are reviewed together. The atomic DAG remains the source of truth and the
// tree-hash invariant is unaffected.
//
// Every rule here is deterministic and non-AI. Candidates are considered in a
// fixed order, and any merge that would make the projection graph cyclic is
// rejected, so replanning the same branch yields the same projections.

export type MergeRule =
  | "same-file" // a file's top-level hunks joining that file's own symbol slice
  | "test-affinity" // a test-only slice joining the production slice it exercises
  | "sole-consumer" // a low-fanout helper absorbed into its only consumer
  | "directory-affinity"; // budget-driven: same feature directory

export type Projection = {
  label: string; // "projection0", in topological order
  signature: string; // stable identity: hash of the constituent group keys
  sliceIds: string[];
  slices: string[]; // constituent atomic slice labels
  files: string[];
  symbols: string[];
  hunkCount: number; // review-size proxy: what a budget is actually balancing
  prerequisites: string[]; // projection labels this one must land after
  merges: { rule: MergeRule; absorbed: string; into: string }[];
  pinned: boolean; // holds a force_split-pinned group — never merged
  fallbackOnly: boolean;
};

export type CoarsenResult = {
  projections: Projection[];
  order: string[]; // projection labels, topological
  edges: [string, string][]; // [dependent, prerequisite]
  atomicSliceCount: number;
  targetSlices: number | null;
  targetMet: boolean;
  unmetReason: "size-cap" | "structure" | null;
  largestProjectionHunks: number;
};

const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const isTestFile = (f: string) => TEST_FILE.test(f);
const productionCounterpart = (f: string) => f.replace(/\.(test|spec)\.([cm]?[jt]sx?)$/, ".$2");
const dirSegments = (f: string) => f.split("/").slice(0, -1);

export function computeProjections(plan: PlanResult, opts: { targetSlices?: number } = {}): CoarsenResult {
  if (!plan.order) throw new DripError("cannot coarsen a plan with a dependency cycle — resolve the cycle first (see `drip plan`)");
  const order = plan.order;
  const targetSlices = opts.targetSlices ?? null;
  if (targetSlices !== null && targetSlices < 1) throw new DripError("--target-slices must be at least 1");

  const rank = new Map(order.map((id, i) => [id, i]));
  const sliceLabel = (id: string) => `slice${plan.idToNum.get(id)}`;
  const hunksOf = (id: string) => plan.slices.get(id)!;
  const filesOf = new Map(order.map((id) => [id, [...new Set(hunksOf(id).map((h) => h.file))].sort()]));

  // force_split says "this must stay independently reviewable". Coarsening
  // that merged it away would silently overrule a durable human decision.
  const forceSplit = new Set(plan.overrides.filter((o) => o.kind === "force_split").map((o) => o.selectorA));
  const pinned = new Set(order.filter((id) => hunksOf(id).some((h) => forceSplit.has(groupKeyOf(h)))));

  // Union-find without path compression: a rejected merge has to be undoable,
  // and the chains here are a few dozen deep at worst.
  const parent = new Map(order.map((id) => [id, id]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  const roots = () => order.filter((id) => find(id) === id);
  const membersOf = (root: string) => order.filter((id) => find(id) === root);

  const quotientEdges = (): [string, string][] => {
    const seen = new Set<string>();
    for (const [from, to] of plan.edges) {
      const f = find(from);
      const t = find(to);
      if (f !== t) seen.add(`${f} ${t}`);
    }
    return [...seen].map((s) => s.split(" ") as [string, string]);
  };

  const merges = new Map<string, { rule: MergeRule; absorbed: string; into: string }[]>();

  // Merging two projections in a DAG can introduce a cycle (A -> C -> B makes
  // {A,B} both before and after C). Rather than reason about reachability, do
  // the merge and re-topo-sort the quotient graph — n is small and "did this
  // stay a DAG" is exactly the question, with no second implementation to get
  // subtly wrong.
  const tryMerge = (a: string, b: string, rule: MergeRule): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (pinned.has(ra) || pinned.has(rb)) return false;

    const survivor = rank.get(ra)! <= rank.get(rb)! ? ra : rb;
    const absorbed = survivor === ra ? rb : ra;
    parent.set(absorbed, survivor);
    if (!topoSort(roots(), quotientEdges())) {
      parent.set(absorbed, absorbed); // undo
      return false;
    }
    const log = merges.get(survivor) ?? [];
    log.push(...(merges.get(absorbed) ?? []), { rule, absorbed: sliceLabel(absorbed), into: sliceLabel(survivor) });
    merges.set(survivor, log);
    merges.delete(absorbed);
    return true;
  };

  const directPrereqs = new Map<string, string[]>(order.map((id) => [id, []]));
  const directDependents = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const [from, to] of plan.edges) {
    if (!directPrereqs.get(from)!.includes(to)) directPrereqs.get(from)!.push(to);
    if (!directDependents.get(to)!.includes(from)) directDependents.get(to)!.push(from);
  }

  // --- rule: same-file -------------------------------------------------------
  // A file's top-level hunks (imports, module-scope statements) are a fallback
  // group only because no definition encloses them — they are not a separate
  // change. When that file's symbol hunks all sit in one slice, they belong
  // together, and keeping them apart is what makes a symbol slice fail its own
  // standalone build check for a missing import.
  for (const id of order) {
    const fallback = plan.fallbackGroups.get(id);
    if (!fallback || fallback.reasons.some((r) => r !== "no-enclosing-symbol")) continue;
    for (const file of fallback.files) {
      const owners = new Set(order.filter((o) => o !== id && !plan.fallbackGroups.has(o) && filesOf.get(o)!.includes(file)).map(find));
      if (owners.size === 1) tryMerge(id, [...owners][0]!, "same-file");
    }
  }

  // --- rule: test-affinity ---------------------------------------------------
  // A test change is not independently reviewable from the production change
  // it covers. Prefer the filename relation (foo.test.ts -> foo.ts) since it's
  // the unambiguous one; fall back to a sole non-test prerequisite.
  const isTestOnly = (id: string) => filesOf.get(id)!.every(isTestFile);
  for (const id of order) {
    if (!isTestOnly(id)) continue;
    const counterparts = new Set(filesOf.get(id)!.map(productionCounterpart).filter((f) => !isTestFile(f)));
    const byName = order.filter((o) => o !== id && filesOf.get(o)!.some((f) => counterparts.has(f)));
    if (byName.length) {
      if (tryMerge(id, byName.sort((a, b) => rank.get(a)! - rank.get(b)!)[0]!, "test-affinity")) continue;
    }
    const prereqs = new Set(directPrereqs.get(id)!.filter((p) => !isTestOnly(p)).map(find));
    if (prereqs.size === 1) tryMerge(id, [...prereqs][0]!, "test-affinity");
  }

  // --- rule: sole-consumer ---------------------------------------------------
  // A helper referenced by exactly one other slice in this diff has no separate
  // audience: reviewing it alone means reviewing a definition with no call site.
  // Fallback groups are deliberately exempt — a lockfile or a docs change with
  // one consumer is still its own reviewable thing (issue #7's shared-dependency
  // projection), not a fragment of that consumer.
  for (const id of order) {
    const root = find(id);
    if (root !== id) continue;
    // Exempt on what the projection *holds*, not on which slice id happens to
    // be its root — an earlier merge can leave a mixed projection rooted at a
    // fallback slice.
    if (membersOf(root).every((m) => plan.fallbackGroups.has(m))) continue;
    const dependents = new Set(membersOf(root).flatMap((m) => directDependents.get(m)!).map(find));
    dependents.delete(root);
    if (dependents.size === 1) tryMerge(root, [...dependents][0]!, "sole-consumer");
  }

  // --- rule: directory-affinity (budget-driven) ------------------------------
  // Only runs against an explicit budget: "everything under this feature
  // directory is one PR" is a reasonable last resort for hitting a review-size
  // target, but a bad default. Dependency manifests and unsupported-language
  // files (docs, config) stay out of it — they're separate projections unless
  // an override says otherwise.
  let targetMet = targetSlices === null;
  // Why a requested budget wasn't reached: "size-cap" means further merges
  // would have produced one runaway projection, "structure" means cycles or
  // force_split pins blocked them. The distinction matters — the first says
  // the budget is too aggressive for this diff, the second that it's
  // unreachable at any size.
  let unmetReason: "size-cap" | "structure" | null = null;
  if (targetSlices !== null) {
    const eligible = (root: string) => {
      if (pinned.has(root)) return false;
      const fallback = plan.fallbackGroups.get(root);
      return !fallback || fallback.reasons.every((r) => r === "no-enclosing-symbol");
    };
    const maxDepth = Math.max(0, ...order.flatMap((id) => filesOf.get(id)!.map((f) => dirSegments(f).length)));
    const rejected = new Set<string>();
    const sizeOf = (root: string) => membersOf(root).reduce((n, m) => n + hunksOf(m).length, 0);

    // A budget asks for N *reviewable* units, not N buckets one of which holds
    // everything. Seeding every merge in a bucket at its first member produced
    // exactly that: on a real 161-slice branch `--target-slices 12` met the
    // count by folding 149 slices into one projection (issue #9). So pair the
    // two smallest candidates, and refuse any merge that would push a
    // projection past twice its fair share of the diff.
    const totalHunks = order.reduce((n, id) => n + hunksOf(id).length, 0);
    const sizeCap = Math.max(1, Math.ceil(totalHunks / targetSlices) * 2);
    let cappedOut = false;

    while (roots().length > targetSlices) {
      let merged = false;
      // Deepest directory first: `src/features/appeals` before `src`.
      for (let depth = maxDepth; depth >= 1 && !merged; depth--) {
        const buckets = new Map<string, string[]>();
        for (const root of roots()) {
          if (!eligible(root)) continue;
          const dirs = membersOf(root).flatMap((m) => filesOf.get(m)!.map((f) => dirSegments(f)));
          if (!dirs.length || dirs.some((d) => d.length < depth)) continue;
          const prefix = dirs[0]!.slice(0, depth).join("/");
          if (!dirs.every((d) => d.slice(0, depth).join("/") === prefix)) continue;
          const list = buckets.get(prefix) ?? [];
          list.push(root);
          buckets.set(prefix, list);
        }
        for (const prefix of [...buckets.keys()].sort()) {
          // Smallest first, rank only as a deterministic tie-break.
          const group = buckets.get(prefix)!.sort((a, b) => sizeOf(a) - sizeOf(b) || rank.get(a)! - rank.get(b)!);
          for (let i = 0; i < group.length && !merged; i++) {
            for (let j = i + 1; j < group.length; j++) {
              const a = group[i]!;
              const b = group[j]!;
              const pair = `${a} ${b}`;
              if (rejected.has(pair)) continue;
              if (sizeOf(a) + sizeOf(b) > sizeCap) {
                // Not permanently rejected: a later pass may pair either side
                // with something small enough.
                cappedOut = true;
                continue;
              }
              if (tryMerge(a, b, "directory-affinity")) {
                merged = true;
                break;
              }
              rejected.add(pair);
            }
          }
          if (merged) break;
        }
      }
      if (!merged) break; // nothing mergeable without a cycle or past the cap
    }
    targetMet = roots().length <= targetSlices;
    if (!targetMet) unmetReason = cappedOut ? "size-cap" : "structure";
  }

  // --- emit ------------------------------------------------------------------
  const finalRoots = roots();
  const projOrder = topoSort(finalRoots, quotientEdges());
  // Merges are only ever accepted when the quotient graph stays acyclic, so
  // this cannot be null — assert rather than silently degrade.
  if (!projOrder) throw new DripError("internal: coarsening produced a cyclic projection graph");

  const labelOf = new Map(projOrder.map((root, i) => [root, `projection${i}`]));
  const edges = quotientEdges().map(([from, to]) => [labelOf.get(from)!, labelOf.get(to)!] as [string, string]);

  const projections: Projection[] = projOrder.map((root) => {
    const sliceIds = membersOf(root);
    const hunks: Hunk[] = sliceIds.flatMap(hunksOf);
    const prereqs = quotientEdges()
      .filter(([from]) => from === root)
      .map(([, to]) => labelOf.get(to)!)
      .sort();
    return {
      label: labelOf.get(root)!,
      // Identity is the constituent group keys, not the projection's position:
      // it survives replanning and renumbering, same principle as the slice
      // signature (docs/adr/0006).
      signature: createHash("sha1").update([...new Set(hunks.map(groupKeyOf))].sort().join("|")).digest("hex").slice(0, 12),
      sliceIds,
      slices: sliceIds.map(sliceLabel),
      files: [...new Set(hunks.map((h) => h.file))].sort(),
      symbols: [...new Set(hunks.map((h) => h.qualifiedSymbol).filter((s): s is string => !!s))].sort(),
      hunkCount: hunks.length,
      prerequisites: [...new Set(prereqs)],
      merges: merges.get(root) ?? [],
      pinned: pinned.has(root),
      fallbackOnly: sliceIds.every((id) => plan.fallbackGroups.has(id)),
    };
  });

  return {
    projections,
    order: projOrder.map((r) => labelOf.get(r)!),
    edges,
    atomicSliceCount: order.length,
    targetSlices,
    targetMet,
    unmetReason,
    largestProjectionHunks: Math.max(0, ...projections.map((p) => p.hunkCount)),
  };
}

export function projectionsToJson(coarse: CoarsenResult): object {
  return {
    atomicSliceCount: coarse.atomicSliceCount,
    projectionCount: coarse.projections.length,
    targetSlices: coarse.targetSlices,
    targetMet: coarse.targetMet,
    unmetReason: coarse.unmetReason,
    largestProjectionHunks: coarse.largestProjectionHunks,
    projections: coarse.projections.map((p) => ({
      projection: p.label,
      signature: p.signature,
      slices: p.slices,
      prerequisites: p.prerequisites,
      files: p.files,
      symbols: p.symbols,
      hunkCount: p.hunkCount,
      merges: p.merges,
      pinned: p.pinned,
      fallbackOnly: p.fallbackOnly,
    })),
    // Not `edges`: this object is merged into the plan's JSON, whose `edges`
    // are the atomic slice DAG's. Two different graphs, two different keys.
    projectionEdges: coarse.edges.map(([from, to]) => ({ from, dependsOn: to })),
  };
}

export function printProjections(coarse: CoarsenResult): void {
  console.log(`\nPROJECTIONS (${coarse.projections.length} candidate PRs from ${coarse.atomicSliceCount} atomic slices):`);
  for (const p of coarse.projections) {
    const tags = [p.pinned ? "pinned" : null, p.fallbackOnly ? "fallback" : null].filter(Boolean).join(", ");
    console.log(`  ${p.label}${tags ? ` (${tags})` : ""}: ${p.slices.length} slice(s), ${p.hunkCount} hunk(s)`);
    console.log(`    ${p.slices.join(", ")}`);
    for (const f of p.files) console.log(`    ${f}`);
    if (p.prerequisites.length) console.log(`    requires: ${p.prerequisites.join(", ")}`);
    for (const m of p.merges) console.log(`    merged ${m.absorbed} into ${m.into} (${m.rule})`);
  }
  if (coarse.targetSlices !== null && !coarse.targetMet) {
    const why =
      coarse.unmetReason === "size-cap"
        ? "further merges would have produced one runaway projection rather than a reviewable unit — the budget is too aggressive for this diff's shape"
        : "further merges would make the projection graph cyclic, or are pinned by a force_split override";
    console.log(`\n  note: stopped at ${coarse.projections.length} projections, short of --target-slices ${coarse.targetSlices}: ${why}.`);
    console.log(`  largest projection: ${coarse.largestProjectionHunks} hunk(s). Coarsening cannot derive semantic boundaries — see \`--manifest\`.`);
  }
}
