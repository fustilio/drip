import { Parser, Language, type Node } from "web-tree-sitter";
import type { GitBackend } from "./git-backend";
import type { Override } from "./store";

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
};

export type FileSection = { header: string; path: string; hunks: Hunk[] };

export type PlanResult = {
  hunks: Hunk[];
  files: FileSection[];
  slices: Map<string, Hunk[]>;
  edges: [string, string][];
  order: string[] | null;
  idToNum: Map<string, number>;
  ungroupedId: string;
  ignoredOverrides: string[];
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
      });
    }
    if (hunks.length) files.push({ header, path, hunks });
  }
  return files;
}

async function loadLanguageFor(path: string): Promise<Language | null> {
  const wasm = path.endsWith(".tsx")
    ? "node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm"
    : path.endsWith(".ts")
      ? "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm"
      : /\.(js|jsx|mjs|cjs)$/.test(path)
        ? "node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm"
        : null;
  if (!wasm) return null;
  return Language.load(wasm);
}

function isDefinition(n: Node): boolean {
  if (!DEF_TYPES.has(n.type)) return false;
  if (n.type === "variable_declarator") {
    const value = n.childForFieldName("value");
    return value?.type === "arrow_function" || value?.type === "function_expression" || value?.type === "function";
  }
  return true;
}

// Returns the dot-joined ancestor chain of definition names enclosing line0,
// e.g. "UserService.getUser" — not just the innermost name. Two same-named
// symbols in different scopes must not collide (docs/adr/0004).
function findQualifiedSymbol(root: Node, line0: number): string | null {
  // Mutable box, not a reassigned nullable — TS's control-flow narrowing
  // doesn't track mutations made inside a nested closure reliably.
  const best = { path: "", span: Infinity, found: false };

  function visit(node: Node, ancestry: string[]) {
    if (!(node.startPosition.row <= line0 && line0 <= node.endPosition.row)) return;
    let nextAncestry = ancestry;
    if (isDefinition(node)) {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        nextAncestry = [...ancestry, name];
        const span = node.endPosition.row - node.startPosition.row;
        if (span < best.span) {
          best.path = nextAncestry.join(".");
          best.span = span;
          best.found = true;
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child, nextAncestry);
  }

  visit(root, []);
  return best.found ? best.path : null;
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
    return { hunks: [], files, slices: new Map(), edges: [], order: [], idToNum: new Map(), ungroupedId: UNGROUPED, ignoredOverrides: [] };
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
          hunk.qualifiedSymbol = sym;
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
  const definersByName = new Map<string, number[]>();
  for (const h of allHunks) {
    if (!h.qualifiedSymbol) continue;
    const leaf = h.qualifiedSymbol.split(".").pop()!;
    const list = definersByName.get(leaf) ?? [];
    list.push(h.index);
    definersByName.set(leaf, list);
  }

  const sliceOf = (h: Hunk) => (h.qualifiedSymbol ? String(uf.find(h.index)) : UNGROUPED);

  const sliceEdges = new Set<string>();
  for (const b of allHunks) {
    for (const [name, definerIdxs] of definersByName) {
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(b.changedText)) continue;
      for (const aIdx of definerIdxs) {
        const a = allHunks[aIdx]!;
        if (a.index === b.index) continue;
        const from = sliceOf(b),
          to = sliceOf(a);
        if (from !== to) sliceEdges.add(`${from} ${to}`);
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

  const edges = [...sliceEdges].map((e) => e.split(" ") as [string, string]);
  const order = topoSort([...slices.keys()], edges);
  const idToNum = order ? new Map(order.map((id, i) => [id, i])) : new Map();

  return { hunks: allHunks, files, slices, edges, order, idToNum, ungroupedId: UNGROUPED, ignoredOverrides };
}

export function printPlan(plan: PlanResult): void {
  if (!plan.order) {
    console.error("PLAN: FAIL — dependency cycle in slice DAG");
    return;
  }
  console.log("SLICES:");
  for (const id of plan.order) {
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
}
