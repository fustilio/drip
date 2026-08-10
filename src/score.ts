import { readFileSync } from "node:fs";
import { z } from "zod";
import { DripError } from "./errors";
import { groupKeyOf, type Hunk } from "./planner";

// Boundary scoring: the instrument under drip's central claim (issues #15, #16).
//
// BUILD-PLAN's M0 kill gate is a question, not a feature: "are the proposed
// boundaries ones you'd have drawn by hand? If under two-thirds are, stop."
// Everything drip does rests on the answer, and until now the answer had no
// way of being produced twice the same way — it was an impression formed while
// reading a plan, which is exactly the kind of evidence a tool built to replace
// impressions should not run on.
//
// So the comparison gets an implementation. A human (or a team) writes down the
// partition they would have drawn, in the same durable group-key selectors
// everything else here uses, and this scores drip's partition against it. Two
// properties matter more than the number itself:
//
//   - It is deterministic. The same plan and the same hand-drawn partition give
//     the same score, so a change to the planner can be measured against it.
//   - It is explainable. A score is useless if it can't say *which* boundary it
//     disagreed about, so every disagreement is reported by selector, and the
//     two ways of being wrong — one unit split apart, two units merged — are
//     named separately rather than summed into one number.
//
// The hand-drawn partition itself is an input file, never a repository artifact:
// the material worth scoring against is somebody's real branch. Nothing in this
// module reads or writes anything but the file it is given.

export const ExpectedPartitionSchema = z.object({
  version: z.literal(1),
  /** free-text name for the exercise — deliberately not required to identify a repo or branch */
  label: z.string().optional(),
  units: z
    .array(
      z.object({
        id: z.string().min(1),
        /** durable group keys — `file::Symbol`, `file::(file)` — the same selectors overrides and manifests use */
        selectors: z.array(z.string().min(1)).min(1),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

export type ExpectedPartition = z.infer<typeof ExpectedPartitionSchema>;

export type ScoreLayer = "atomic" | "candidates" | "manifest";

export type UnitScore = {
  /** the hand-drawn unit */
  id: string;
  /** the drip unit it was matched to, or null when every drip unit it touches was matched to some other hand-drawn unit */
  matched: string | null;
  hunks: number;
  agreed: number;
  /** every drip unit this hand-drawn unit's hunks landed in — more than one means drip split it */
  spread: string[];
  /** other hand-drawn units sharing this one's matched drip unit — drip merged them */
  sharedWith: string[];
};

export type ScoreResult = {
  layer: ScoreLayer;
  label: string | null;
  threshold: number;
  agreement: number;
  scoredHunks: number;
  agreedHunks: number;
  /** hunks in the plan that no hand-drawn unit named — not counted either way */
  unscoredHunks: number;
  /** hunks skipped because they belong to a fallback group (see includeFallback) */
  excludedFallbackHunks: number;
  /** selectors that matched no hunk in this plan — reported, never silently dropped */
  unmatchedSelectors: string[];
  /** selectors named by two hand-drawn units: the input isn't a partition */
  duplicateSelectors: string[];
  units: UnitScore[];
  disagreements: Array<{ selector: string; expected: string; actual: string; hunks: number }>;
  pass: boolean;
};

export function loadExpectedPartition(path: string): ExpectedPartition {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new DripError(`could not read the hand-drawn partition ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new DripError(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = ExpectedPartitionSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new DripError(`${path} does not match the v1 hand-drawn partition schema:\n${issues}`);
  }
  const ids = result.data.units.map((u) => u.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new DripError(`${path} declares two units with id '${duplicate}' — unit ids are how the report names a boundary`);
  return result.data;
}

/** The default gate, from BUILD-PLAN §7's M0 milestone: under two-thirds, stop. */
export const DEFAULT_THRESHOLD = 2 / 3;

export function scoreBoundaries(opts: {
  /** drip's partition: whatever layer is being scored, in the shape verify already consumes */
  units: { order: string[]; slices: Map<string, Hunk[]> };
  expected: ExpectedPartition;
  layer: ScoreLayer;
  /**
   * Fallback groups are keyed by path, not computed from the symbol graph, so
   * scoring them measures the filesystem rather than drip's clustering. Off by
   * default (CONTEXT.md's fallback-group entry says so); on when the caller
   * wants the whole partition scored end to end.
   */
  includeFallback?: boolean;
  threshold?: number;
}): ScoreResult {
  const { units, expected, layer } = opts;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const includeFallback = !!opts.includeFallback;

  // --- the hand-drawn partition ----------------------------------------------
  const expectedOf = new Map<string, string>(); // selector -> hand-drawn unit id
  const duplicateSelectors: string[] = [];
  for (const unit of expected.units) {
    for (const selector of unit.selectors) {
      const existing = expectedOf.get(selector);
      if (existing && existing !== unit.id) {
        duplicateSelectors.push(selector);
        continue; // first declaration wins, deterministically
      }
      expectedOf.set(selector, unit.id);
    }
  }

  // --- drip's partition, restricted to what was hand-drawn -------------------
  const rank = new Map(units.order.map((id, i) => [id, i]));
  const actualOf = new Map<number, string>(); // hunk index -> drip unit
  const keyOf = new Map<number, string>();
  const seenSelectors = new Set<string>();
  let unscoredHunks = 0;
  let excludedFallbackHunks = 0;

  const scored: Hunk[] = [];
  for (const id of units.order) {
    for (const hunk of units.slices.get(id) ?? []) {
      const key = groupKeyOf(hunk);
      if (!expectedOf.has(key)) {
        unscoredHunks++;
        continue;
      }
      // Seen either way: a named selector that exists in the plan is not
      // "unmatched" just because the fallback rule kept it out of the score.
      seenSelectors.add(key);
      if (hunk.qualifiedSymbol === null && !includeFallback) {
        excludedFallbackHunks++;
        continue;
      }
      actualOf.set(hunk.index, id);
      keyOf.set(hunk.index, key);
      scored.push(hunk);
    }
  }

  const unmatchedSelectors = [...expectedOf.keys()].filter((s) => !seenSelectors.has(s)).sort();

  // --- match hand-drawn units to drip units, one to one ----------------------
  // Injective on purpose. A plurality mapping would score "drip merged these
  // two features into one PR" as a perfect result for both, which is the exact
  // failure the gate exists to catch. Here the larger overlap keeps the drip
  // unit and the other hand-drawn unit counts as disagreement — a merge and a
  // split are both boundary errors, and both are visible in the numbers.
  // Nested rather than a joined string key: a unit id and a selector can both
  // contain almost anything, so a separator that can appear inside a key is a
  // bug waiting for the first path with a space in it.
  const overlap = new Map<string, Map<string, number>>(); // expected id -> drip id -> hunks
  const hunksPerExpected = new Map<string, number>(expected.units.map((u) => [u.id, 0]));
  const spread = new Map<string, Set<string>>(expected.units.map((u) => [u.id, new Set<string>()]));
  for (const hunk of scored) {
    const e = expectedOf.get(keyOf.get(hunk.index)!)!;
    const a = actualOf.get(hunk.index)!;
    const row = overlap.get(e) ?? new Map<string, number>();
    row.set(a, (row.get(a) ?? 0) + 1);
    overlap.set(e, row);
    hunksPerExpected.set(e, (hunksPerExpected.get(e) ?? 0) + 1);
    spread.get(e)!.add(a);
  }

  const pairs = [...overlap.entries()]
    .flatMap(([e, row]) => [...row.entries()].map(([a, count]) => ({ expected: e, actual: a, count })))
    // Deterministic: biggest overlap first, then hand-drawn declaration order,
    // then drip's own topological order. No ties are broken by chance.
    .sort(
      (x, y) =>
        y.count - x.count ||
        expected.units.findIndex((u) => u.id === x.expected) - expected.units.findIndex((u) => u.id === y.expected) ||
        (rank.get(x.actual) ?? 0) - (rank.get(y.actual) ?? 0),
    );

  const matchOf = new Map<string, string>();
  const takenDripUnits = new Set<string>();
  for (const pair of pairs) {
    if (matchOf.has(pair.expected) || takenDripUnits.has(pair.actual)) continue;
    matchOf.set(pair.expected, pair.actual);
    takenDripUnits.add(pair.actual);
  }

  // --- score ------------------------------------------------------------------
  let agreedHunks = 0;
  const agreedPerExpected = new Map<string, number>(expected.units.map((u) => [u.id, 0]));
  const disagreementCounts = new Map<string, { selector: string; expected: string; actual: string; hunks: number }>();
  for (const hunk of scored) {
    const key = keyOf.get(hunk.index)!;
    const e = expectedOf.get(key)!;
    const a = actualOf.get(hunk.index)!;
    if (matchOf.get(e) === a) {
      agreedHunks++;
      agreedPerExpected.set(e, (agreedPerExpected.get(e) ?? 0) + 1);
      continue;
    }
    const existing = disagreementCounts.get(key);
    if (existing) existing.hunks++;
    else disagreementCounts.set(key, { selector: key, expected: e, actual: a, hunks: 1 });
  }

  const sharedWith = new Map<string, string[]>();
  for (const unit of expected.units) {
    const mine = matchOf.get(unit.id);
    if (!mine) continue;
    sharedWith.set(
      unit.id,
      expected.units.filter((o) => o.id !== unit.id && spread.get(o.id)!.has(mine)).map((o) => o.id),
    );
  }

  const unitScores: UnitScore[] = expected.units.map((unit) => ({
    id: unit.id,
    matched: matchOf.get(unit.id) ?? null,
    hunks: hunksPerExpected.get(unit.id) ?? 0,
    agreed: agreedPerExpected.get(unit.id) ?? 0,
    spread: [...spread.get(unit.id)!].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    sharedWith: sharedWith.get(unit.id) ?? [],
  }));

  const scoredHunks = scored.length;
  const agreement = scoredHunks ? agreedHunks / scoredHunks : 0;

  return {
    layer,
    label: expected.label ?? null,
    threshold,
    agreement,
    scoredHunks,
    agreedHunks,
    unscoredHunks,
    excludedFallbackHunks,
    unmatchedSelectors,
    duplicateSelectors: [...new Set(duplicateSelectors)].sort(),
    units: unitScores,
    disagreements: [...disagreementCounts.values()].sort((a, b) => b.hunks - a.hunks || a.selector.localeCompare(b.selector)),
    // A run that scored nothing is not a pass. Every selector missing usually
    // means the partition was drawn against a different plan than the one here.
    pass: scoredHunks > 0 && agreement >= threshold,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const LAYER_NAME: Record<ScoreLayer, string> = {
  atomic: "atomic slices",
  candidates: "coarsened candidate projections",
  manifest: "manifest projections",
};

export function scoreToJson(result: ScoreResult): object {
  return { ...result };
}

export function printScoreReport(result: ScoreResult): void {
  console.log(
    `SCORE (${LAYER_NAME[result.layer]} vs ${result.units.length} hand-drawn unit(s)${result.label ? `, '${result.label}'` : ""}):`,
  );
  for (const unit of result.units) {
    if (!unit.hunks) {
      console.log(`  ${unit.id}: no hunks in this plan — its selectors matched nothing scoreable`);
      continue;
    }
    // "unmatched" on its own reads as a bug; it is always a merge seen from the
    // losing side, so it says which unit took the drip unit this one landed in.
    const shape =
      unit.matched === null
        ? `absorbed into ${unit.spread.join(", ")}`
        : unit.spread.length > 1
          ? `split across ${unit.spread.join(", ")}`
          : unit.sharedWith.length
            ? `merged with ${unit.sharedWith.join(", ")}`
            : "exact";
    console.log(`  ${unit.id}: ${unit.agreed}/${unit.hunks} hunk(s) -> ${unit.matched ?? "(unmatched)"} (${shape})`);
  }

  if (result.disagreements.length) {
    console.log("\nDISAGREEMENTS (hand-drawn unit -> where drip actually put it):");
    for (const d of result.disagreements) console.log(`  ${d.selector}: ${d.expected} -> ${d.actual} (${d.hunks} hunk(s))`);
  }

  if (result.unmatchedSelectors.length) {
    console.log("\nUNMATCHED SELECTORS (named by hand, absent from this plan):");
    for (const s of result.unmatchedSelectors) console.log(`  ${s}`);
  }
  if (result.duplicateSelectors.length) {
    console.log("\nDUPLICATE SELECTORS (named by two hand-drawn units — the first declaration was used):");
    for (const s of result.duplicateSelectors) console.log(`  ${s}`);
  }

  const skipped: string[] = [];
  if (result.unscoredHunks) skipped.push(`${result.unscoredHunks} hunk(s) no hand-drawn unit named`);
  if (result.excludedFallbackHunks) skipped.push(`${result.excludedFallbackHunks} fallback-group hunk(s) (--include-fallback to score them)`);
  if (skipped.length) console.log(`\nNot scored: ${skipped.join("; ")}.`);

  console.log(
    `\nBOUNDARY AGREEMENT: ${pct(result.agreement)} (${result.agreedHunks}/${result.scoredHunks} hunks), ` +
      `threshold ${pct(result.threshold)} — ${result.pass ? "PASS" : "FAIL"}`,
  );
  if (!result.scoredHunks) {
    console.log("  Nothing was scored. The partition's selectors don't appear in this plan — was it drawn against a different branch or base?");
  }
}
