import { Parser, Language, type Node } from "web-tree-sitter";
import { createRequire } from "node:module";
import type { GitBackend } from "./git-backend";
import type { Override } from "./store";

// Resolve relative to this installed module, not the caller's CWD — a global
// install of drip must not depend on the target repo having these grammar
// packages in its own node_modules. See docs/adr/0012-wasm-asset-resolution.md.
const requireFromHere = createRequire(import.meta.url);

const DEF_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "method_definition",
  "variable_declarator",
]);

export type Hunk = {
  index: number;
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  raw: string;
  changedText: string;
  qualifiedSymbol: string | null; // e.g. "UserService.getUser" — see docs/adr/0004-override-selector.md
  exported: boolean; // is the top-level declaration in qualifiedSymbol's chain exported? see docs/adr/0014-def-use-edge-precision.md
};

export type FileSection = { header: string; path: string; hunks: Hunk[] };

// Why a slice->slice edge exists: the symbol reference (leaf name) found in
// the referencing hunk's changed text, and the locations on both ends —
// surfaced in cycle diagnostics so a user can judge real-vs-false-positive.
export type EdgeEvidence = {
  symbol: string;
  referencingFile: string;
  referencingHunk: { startLine: number; endLine: number };
  definitionFile: string;
  definitionHunk: { startLine: number; endLine: number };
};

export type PlanResult = {
  hunks: Hunk[];
  files: FileSection[];
  slices: Map<string, Hunk[]>;
  edges: [string, string][];
  edgeEvidence: Map<string, EdgeEvidence[]>; // key: `${from} ${to}`
  order: string[] | null;
  idToNum: Map<string, number>;
  ungroupedId: string;
  ignoredOverrides: string[];
  overrides: Override[];
};

const UNGROUPED = "ungrouped";

export function parseDiff(diffText: string): FileSection[] {
  const sections = diffText.split(/^diff --git /m).slice(1);
  const files: FileSection[] = [];
  let hunkIndex = 0;

  for (const section of sections) {
    const body = "diff --git " + section;
    const firstHunk = body.search(/^@@ /m);
    const header = firstHunk === -1 ? body : body.slice(0, firstHunk);
    const pathMatch = header.match(/^\+\+\+ b\/(.+)$/m) ?? header.match(/^--- a\/(.+)$/m);
    if (!pathMatch || firstHunk === -1) continue; // binary/rename-only — not handled

    const path = pathMatch[1]!;
    const hunkTexts = body.slice(firstHunk).split(/(?=^@@ )/m);
    const hunks: Hunk[] = [];

    for (const raw of hunkTexts) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const changedText = raw
        .split("\n")
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .filter((l) => !l.startsWith("+++") && !l.startsWith("---"))
        .map((l) => l.slice(1))
        .join("\n");

      hunks.push({
        index: hunkIndex++,
        file: path,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        raw,
        changedText,
        qualifiedSymbol: null,
        exported: false,
      });
    }
    if (hunks.length) files.push({ header, path, hunks });
  }
  return files;
}

async function loadLanguageFor(path: string): Promise<Language | null> {
  const wasm = path.endsWith(".tsx")
    ? "tree-sitter-typescript/tree-sitter-tsx.wasm"
    : path.endsWith(".ts")
      ? "tree-sitter-typescript/tree-sitter-typescript.wasm"
      : /\.(js|jsx|mjs|cjs)$/.test(path)
        ? "tree-sitter-javascript/tree-sitter-javascript.wasm"
        : null;
  if (!wasm) return null;
  return Language.load(requireFromHere.resolve(wasm));
}

function isDefinition(n: Node): boolean {
  if (!DEF_TYPES.has(n.type)) return false;
  if (n.type === "variable_declarator") {
    const value = n.childForFieldName("value");
    return value?.type === "arrow_function" || value?.type === "function_expression" || value?.type === "function";
  }
  return true;
}

// Is `n` (or its variable_declarator/lexical_declaration wrapper) directly
// under an `export` statement? Covers `export function`/`export class`/
// `export const x = ...`/`export default ...` — not `export { x }` named-
// export lists, which would need cross-referencing a separate identifier
// list against local declarations (out of scope, see docs/adr/0014).
function isExportedDeclaration(n: Node): boolean {
  let p: Node | null = n.parent;
  while (p && (p.type === "lexical_declaration" || p.type === "variable_declaration")) p = p.parent;
  return p?.type === "export_statement";
}

// Returns the dot-joined ancestor chain of definition names enclosing line0,
// e.g. "UserService.getUser" — not just the innermost name. Two same-named
// symbols in different scopes must not collide (docs/adr/0004). Also reports
// whether the top-level (module-scope) declaration in that chain is exported —
// used to gate cross-file def-use matching (docs/adr/0014).
function findQualifiedSymbol(root: Node, line0: number): { path: string; exported: boolean } | null {
  // Mutable box, not a reassigned nullable — TS's control-flow narrowing
  // doesn't track mutations made inside a nested closure reliably.
  const best = { path: "", span: Infinity, found: false, exported: false };

  function visit(node: Node, ancestry: string[], topLevelExported: boolean) {
    if (!(node.startPosition.row <= line0 && line0 <= node.endPosition.row)) return;
    let nextAncestry = ancestry;
    let nextTopLevelExported = topLevelExported;
    if (isDefinition(node)) {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        if (ancestry.length === 0) nextTopLevelExported = isExportedDeclaration(node);
        nextAncestry = [...ancestry, name];
        const span = node.endPosition.row - node.startPosition.row;
        if (span < best.span) {
          best.path = nextAncestry.join(".");
          best.span = span;
          best.found = true;
          best.exported = nextTopLevelExported;
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child, nextAncestry, nextTopLevelExported);
  }

  visit(root, [], false);
  return best.found ? { path: best.path, exported: best.exported } : null;
}

// The cross-file def-use key for a qualified symbol. Constructors all share
// the leaf "constructor" — matching on that literal word creates a spurious
// edge between any two changed classes' constructors, since every changed
// constructor's own declaration contains the word "constructor" (issue #4).
// The enclosing class name is the meaningful key: that's what a caller
// actually writes (`new Service()`), not the word "constructor" itself.
function defUseKey(qualifiedSymbol: string): string {
  const parts = qualifiedSymbol.split(".");
  const leaf = parts[parts.length - 1]!;
  return leaf === "constructor" && parts.length > 1 ? parts[parts.length - 2]! : leaf;
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function topoSort(nodes: string[], edges: [string, string][]): string[] | null {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) {
    adj.get(to)!.push(from); // apply dependency (to) before dependent (from)
    indeg.set(from, (indeg.get(from) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  const out: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    for (const m of adj.get(n)!) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  return out.length === nodes.length ? out : null;
}

export async function computePlan(opts: {
  git: GitBackend;
  repoRoot: string;
  branch: string;
  baseBranch?: string;
  overrides?: Override[];
}): Promise<PlanResult> {
  const { git, repoRoot, branch } = opts;
  const baseBranch = opts.baseBranch ?? "main";
  const overrides = opts.overrides ?? [];

  const mergeBase = git.mergeBase(baseBranch, branch, repoRoot);
  const diffText = git.diff(mergeBase, branch, repoRoot);
  const files = parseDiff(diffText);
  const allHunks: Hunk[] = files.flatMap((f) => f.hunks);

  if (allHunks.length === 0) {
    return {
      hunks: [],
      files,
      slices: new Map(),
      edges: [],
      edgeEvidence: new Map(),
      order: [],
      idToNum: new Map(),
      ungroupedId: UNGROUPED,
      ignoredOverrides: [],
      overrides,
    };
  }

  await Parser.init();
  const langCache = new Map<string, Language | null>();
  const parser = new Parser();

  for (const file of files) {
    const ext = file.path.slice(file.path.lastIndexOf("."));
    if (!langCache.has(ext)) langCache.set(ext, await loadLanguageFor(file.path));
    const lang = langCache.get(ext)!;
    if (!lang) continue;

    let content: string;
    try {
      content = git.show(branch, file.path, repoRoot);
    } catch {
      try {
        content = git.show(mergeBase, file.path, repoRoot);
      } catch {
        continue;
      }
    }

    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (!tree) continue;

    for (const hunk of file.hunks) {
      const start = hunk.newLines > 0 ? hunk.newStart : hunk.oldStart;
      const count = Math.max(hunk.newLines, hunk.oldLines, 1);
      for (let line = start; line < start + count; line++) {
        const sym = findQualifiedSymbol(tree.rootNode, line - 1);
        if (sym) {
          hunk.qualifiedSymbol = sym.path;
          hunk.exported = sym.exported;
          break;
        }
      }
    }
  }

  const groupKey = (h: Hunk) => `${h.file}::${h.qualifiedSymbol}`;

  const forceSplit = new Set(overrides.filter((o) => o.kind === "force_split").map((o) => o.selectorA));
  const forceMerge = overrides.filter((o) => o.kind === "force_merge" && o.selectorB);
  const matchedSelectors = new Set<string>();

  // Co-modification clustering: same file + same qualified symbol unions hunks,
  // unless pinned apart by a force_split override.
  const uf = new UnionFind(allHunks.length);
  const byGroup = new Map<string, number[]>();
  for (const h of allHunks) {
    if (!h.qualifiedSymbol) continue;
    const key = groupKey(h);
    if (forceSplit.has(key)) {
      matchedSelectors.add(key);
      continue; // never unions with siblings — stays its own slice
    }
    const list = byGroup.get(key) ?? [];
    list.push(h.index);
    byGroup.set(key, list);
  }
  for (const list of byGroup.values()) for (let i = 1; i < list.length; i++) uf.union(list[0]!, list[i]!);

  // force_merge overrides: union whichever hunks match either selector.
  for (const o of forceMerge) {
    const a = allHunks.filter((h) => h.qualifiedSymbol && groupKey(h) === o.selectorA);
    const b = allHunks.filter((h) => h.qualifiedSymbol && groupKey(h) === o.selectorB);
    if (a.length) matchedSelectors.add(o.selectorA);
    if (b.length) matchedSelectors.add(o.selectorB!);
    if (a.length && b.length) uf.union(a[0]!.index, b[0]!.index);
  }

  const ignoredOverrides = overrides
    .flatMap((o) => [o.selectorA, o.selectorB].filter((s): s is string => !!s))
    .filter((s) => !matchedSelectors.has(s));

  // Def-use edges: reference-matching uses the leaf symbol name (how code
  // actually calls it), grouping/selectors use the full qualified path.
  // Constructors are keyed by their enclosing class name, not the literal
  // word "constructor" (issue #4, see docs/adr/0014).
  const definersByName = new Map<string, number[]>();
  for (const h of allHunks) {
    if (!h.qualifiedSymbol) continue;
    const key = defUseKey(h.qualifiedSymbol);
    const list = definersByName.get(key) ?? [];
    list.push(h.index);
    definersByName.set(key, list);
  }

  const sliceOf = (h: Hunk) => (h.qualifiedSymbol ? String(uf.find(h.index)) : UNGROUPED);

  const sliceEdges = new Map<string, EdgeEvidence[]>();
  const hunkLoc = (h: Hunk) => ({ startLine: h.newStart, endLine: h.newStart + Math.max(h.newLines, 1) - 1 });
  for (const b of allHunks) {
    for (const [name, definerIdxs] of definersByName) {
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(b.changedText)) continue;
      for (const aIdx of definerIdxs) {
        const a = allHunks[aIdx]!;
        if (a.index === b.index) continue;
        // Cross-file matching on a name alone is unsound for unexported
        // locals (issue #5) — two files can each define their own private
        // `renderSection`. Require the definer to be exported once files
        // differ; same-file matching is unaffected (name is unambiguous
        // enough within one file for this heuristic).
        if (a.file !== b.file && !a.exported) continue;
        const from = sliceOf(b),
          to = sliceOf(a);
        if (from === to) continue;
        const key = `${from} ${to}`;
        const evidence = sliceEdges.get(key) ?? [];
        evidence.push({
          symbol: name,
          referencingFile: b.file,
          referencingHunk: hunkLoc(b),
          definitionFile: a.file,
          definitionHunk: hunkLoc(a),
        });
        sliceEdges.set(key, evidence);
      }
    }
  }

  const slices = new Map<string, Hunk[]>();
  for (const h of allHunks) {
    const id = sliceOf(h);
    const list = slices.get(id) ?? [];
    list.push(h);
    slices.set(id, list);
  }

  const edges = [...sliceEdges.keys()].map((e) => e.split(" ") as [string, string]);
  const order = topoSort([...slices.keys()], edges);
  // Cyclic plans still need deterministic slice numbering for diagnostics —
  // fall back to first-seen-in-diff order (the insertion order of `slices`).
  const numberingOrder = order ?? [...slices.keys()];
  const idToNum = new Map(numberingOrder.map((id, i) => [id, i]));

  return { hunks: allHunks, files, slices, edges, edgeEvidence: sliceEdges, order, idToNum, ungroupedId: UNGROUPED, ignoredOverrides, overrides };
}

// Strongly-connected components (Tarjan) restricted to components with more
// than one member — a single-node "SCC" just means no cycle through that
// node, not a cycle to report. Self-loops can't occur here (edge-building
// skips from === to), so size > 1 is the only cycle shape possible.
function findCycles(nodes: string[], edges: [string, string][]): string[][] {
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) adj.get(from)!.push(to);

  let counter = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) sccs.push(component);
    }
  }
  for (const n of nodes) if (!indices.has(n)) strongconnect(n);
  return sccs;
}

export type CycleDiagnostic = {
  slices: string[]; // "slice{n}" ids, in this SCC
  edges: { from: string; dependsOn: string; evidence: EdgeEvidence[] }[];
  overridesTouching: Override[]; // existing overrides whose selector matches a symbol in this cycle
};

export function computeCycleDiagnostics(plan: PlanResult): CycleDiagnostic[] {
  const sccs = findCycles([...plan.slices.keys()], plan.edges);
  const sliceLabel = (id: string) => `slice${plan.idToNum.get(id)}`;

  return sccs.map((component) => {
    const members = new Set(component);
    const symbolsInCycle = new Set<string>();
    for (const id of component) {
      for (const h of plan.slices.get(id) ?? []) {
        if (h.qualifiedSymbol) symbolsInCycle.add(`${h.file}::${h.qualifiedSymbol}`);
      }
    }
    return {
      slices: component.map(sliceLabel),
      edges: plan.edges
        .filter(([from, to]) => members.has(from) && members.has(to))
        .map(([from, to]) => ({ from: sliceLabel(from), dependsOn: sliceLabel(to), evidence: plan.edgeEvidence.get(`${from} ${to}`) ?? [] })),
      overridesTouching: plan.overrides.filter((o) => symbolsInCycle.has(o.selectorA) || (!!o.selectorB && symbolsInCycle.has(o.selectorB))),
    };
  });
}

// Machine-readable plan output — for an external tool (agent, MCP wrapper,
// CI script) to read ambiguous-boundary/naming context and write decisions
// back through the existing `drip override add` CLI. See BUILD-PLAN.md §9:
// the AI belongs upstream of the tool, not inside it.
// Slice display order: topological when acyclic, else the same first-seen
// fallback used for idToNum, so numbering is consistent either way.
function displayOrder(plan: PlanResult): string[] {
  return plan.order ?? [...plan.idToNum.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export function planToJson(plan: PlanResult): object {
  const order = displayOrder(plan);
  const slices = order.map((id) => {
    const hunks = plan.slices.get(id)!.sort((a, b) => a.newStart - b.newStart);
    return {
      slice: `slice${plan.idToNum.get(id)}`,
      ungrouped: id === plan.ungroupedId,
      files: [...new Set(hunks.map((h) => h.file))],
      symbols: [...new Set(hunks.map((h) => h.qualifiedSymbol).filter((s): s is string => !!s))],
      hunks: hunks.map((h) => ({ file: h.file, startLine: h.newStart, endLine: h.newStart + Math.max(h.newLines, 1) - 1 })),
    };
  });
  const edges = plan.edges.map(([from, to]) => ({ from: `slice${plan.idToNum.get(from)}`, dependsOn: `slice${plan.idToNum.get(to)}` }));

  if (!plan.order) {
    return { ok: false, error: "dependency cycle in slice DAG", slices, edges, cycles: computeCycleDiagnostics(plan), unmatchedOverrideSelectors: plan.ignoredOverrides };
  }
  return { ok: true, slices, edges, unmatchedOverrideSelectors: plan.ignoredOverrides };
}

export function printPlan(plan: PlanResult): void {
  const order = displayOrder(plan);
  console.log("SLICES:");
  for (const id of order) {
    console.log(`  slice${plan.idToNum.get(id)}${id === plan.ungroupedId ? " (ungrouped)" : ""}:`);
    for (const h of plan.slices.get(id)!.sort((a, b) => a.newStart - b.newStart)) {
      console.log(`    ${h.file}:${h.newStart}-${h.newStart + Math.max(h.newLines, 1) - 1}`);
    }
  }
  console.log("\nEDGES:");
  for (const [from, to] of plan.edges) console.log(`  slice${plan.idToNum.get(from)} depends-on slice${plan.idToNum.get(to)}`);
  if (plan.ignoredOverrides.length) {
    console.log("\nWARNINGS:");
    for (const s of plan.ignoredOverrides) console.log(`  override selector matched nothing in this diff: ${s}`);
  }

  if (!plan.order) {
    console.log("\nPLAN: FAIL — dependency cycle in slice DAG");
    for (const cycle of computeCycleDiagnostics(plan)) {
      console.log(`\nCYCLE: ${cycle.slices.join(" -> ")}`);
      for (const e of cycle.edges) {
        console.log(`  ${e.from} depends-on ${e.dependsOn}`);
        for (const ev of e.evidence) {
          console.log(
            `    via symbol '${ev.symbol}': ${ev.referencingFile}:${ev.referencingHunk.startLine}-${ev.referencingHunk.endLine} references ${ev.definitionFile}:${ev.definitionHunk.startLine}-${ev.definitionHunk.endLine}`,
          );
        }
      }
      if (cycle.overridesTouching.length) {
        console.log("  overrides touching this cycle:");
        for (const o of cycle.overridesTouching) {
          console.log(`    ${o.kind} ${o.selectorA}${o.selectorB ? ` <-> ${o.selectorB}` : ""}${o.note ? ` (${o.note})` : ""}`);
        }
      } else {
        console.log("  no existing override touches this cycle — consider `drip override add --kind force_split` on one of the symbols above");
      }
    }
  }
}
