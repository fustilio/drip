// M0 spike: throwaway. Answers one question — are computed slice boundaries
// ones a human would draw? See CONTEXT.md for the vocabulary used below.
//
// Usage: bun m0.ts <branch>
//   Diffs <branch> against its merge-base with main, clusters hunks into
//   slices via a symbol-edge graph, prints the slice DAG, and checks the
//   tree-hash invariant.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Parser, Language, type Node } from "web-tree-sitter";

const DEF_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "method_definition",
  "variable_declarator",
]);

type Hunk = {
  index: number;
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  raw: string; // this hunk's own text, starting at "@@ ... @@"
  changedText: string; // added/removed lines, +/- stripped, for symbol-name search
  enclosingSymbol: string | null;
};

type FileSection = { header: string; path: string; hunks: Hunk[] };

function git(args: string[], cwd = process.cwd(), env = process.env): string {
  return execFileSync("git", args, { cwd, env, maxBuffer: 1024 * 1024 * 64 }).toString();
}

function parseDiff(diffText: string): FileSection[] {
  const sections = diffText.split(/^diff --git /m).slice(1);
  const files: FileSection[] = [];
  let hunkIndex = 0;

  for (const section of sections) {
    const body = "diff --git " + section;
    const firstHunk = body.search(/^@@ /m);
    const header = firstHunk === -1 ? body : body.slice(0, firstHunk);
    const pathMatch = header.match(/^\+\+\+ b\/(.+)$/m) ?? header.match(/^--- a\/(.+)$/m);
    if (!pathMatch || firstHunk === -1) continue; // binary/rename-only/no-op section — skip, ponytail: not handled in M0

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
        enclosingSymbol: null,
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

function definitionName(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

function smallestEnclosingDefinition(root: Node, line0: number): string | null {
  let best: Node | null = null;
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.startPosition.row <= line0 && line0 <= n.endPosition.row) {
      if (DEF_TYPES.has(n.type) && definitionName(n)) {
        const span = n.endPosition.row - n.startPosition.row;
        const bestSpan = best ? best.endPosition.row - best.startPosition.row : Infinity;
        if (span < bestSpan) best = n;
      }
      for (const child of n.namedChildren) if (child) stack.push(child);
    }
  }
  return best ? definitionName(best) : null;
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
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

async function main() {
  const branch = process.argv[2];
  if (!branch) {
    console.error("usage: bun m0.ts <branch>");
    process.exit(2);
  }

  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  const mergeBase = git(["merge-base", "main", branch!], repoRoot).trim();
  const diffText = git(["diff", "-U3", mergeBase, branch!], repoRoot);
  const files = parseDiff(diffText);
  const allHunks: Hunk[] = files.flatMap((f) => f.hunks);

  if (allHunks.length === 0) {
    console.log("No hunks found — nothing to slice.");
    return;
  }

  await Parser.init();
  const langCache = new Map<string, Language | null>();
  const parser = new Parser();

  for (const file of files) {
    const ext = file.path.slice(file.path.lastIndexOf("."));
    if (!langCache.has(ext)) langCache.set(ext, await loadLanguageFor(file.path));
    const lang = langCache.get(ext)!;
    if (!lang) continue; // ungrouped — no grammar for this extension

    // Prefer post-change content; fall back to pre-change for deleted files.
    let content: string;
    try {
      content = git(["show", `${branch}:${file.path}`], repoRoot);
    } catch {
      try {
        content = git(["show", `${mergeBase}:${file.path}`], repoRoot);
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
      // Scan every line in the hunk, not just its first — a hunk's first line
      // is often an import or blank line above the symbol it actually touches.
      for (let line = start; line < start + count; line++) {
        const sym = smallestEnclosingDefinition(tree.rootNode, line - 1);
        if (sym) {
          hunk.enclosingSymbol = sym;
          break;
        }
      }
    }
  }

  // Clustering: co-modification only (same file + same enclosing symbol) unions hunks.
  // Def-use (a hunk's text merely referencing another hunk's symbol) becomes a
  // directed slice edge below, never a merge — otherwise every caller of a
  // shared helper would collapse into one giant slice, defeating the point.
  const uf = new UnionFind(allHunks.length);
  const groupKey = (h: Hunk) => `${h.file}::${h.enclosingSymbol}`;
  const byGroup = new Map<string, number[]>();
  for (const h of allHunks) {
    if (!h.enclosingSymbol) continue;
    const key = groupKey(h);
    const list = byGroup.get(key) ?? [];
    list.push(h.index);
    byGroup.set(key, list);
  }
  for (const list of byGroup.values()) for (let i = 1; i < list.length; i++) uf.union(list[0]!, list[i]!);

  // Def-use edges: symbol name -> defining hunk indices, then whole-word scan
  // over every hunk's changed text. Name-only matching, not scope-aware —
  // ponytail: heuristic, upgrade to real reference resolution if this proves noisy.
  const definersByName = new Map<string, number[]>();
  for (const h of allHunks) {
    if (!h.enclosingSymbol) continue;
    const list = definersByName.get(h.enclosingSymbol) ?? [];
    list.push(h.index);
    definersByName.set(h.enclosingSymbol, list);
  }

  const UNGROUPED = "ungrouped";
  const sliceOf = (h: Hunk) => (h.enclosingSymbol ? String(uf.find(h.index)) : UNGROUPED);

  const sliceEdges = new Set<string>(); // "from depends-on to"
  for (const b of allHunks) {
    for (const [name, definerIdxs] of definersByName) {
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(b.changedText)) continue;
      for (const aIdx of definerIdxs) {
        const a = allHunks[aIdx]!;
        if (a.index === b.index) continue;
        const from = sliceOf(b), to = sliceOf(a);
        if (from !== to) sliceEdges.add(`${from} ${to}`);
      }
    }
  }

  // Group hunks into slices for display + topological order.
  const slices = new Map<string, Hunk[]>();
  for (const h of allHunks) {
    const id = sliceOf(h);
    const list = slices.get(id) ?? [];
    list.push(h);
    slices.set(id, list);
  }

  const edges = [...sliceEdges].map((e) => e.split(" ") as [string, string]);
  const order = topoSort([...slices.keys()], edges);
  if (!order) {
    console.error("INVARIANT: FAIL — dependency cycle in slice DAG");
    process.exit(1);
  }

  console.log("SLICES:");
  const idToNum = new Map(order.map((id, i) => [id, i]));
  for (const id of order) {
    console.log(`  slice${idToNum.get(id)}${id === UNGROUPED ? " (ungrouped)" : ""}:`);
    for (const h of slices.get(id)!.sort((a, b) => a.newStart - b.newStart)) {
      console.log(`    ${h.file}:${h.newStart}-${h.newStart + Math.max(h.newLines, 1) - 1}`);
    }
  }
  console.log("\nEDGES:");
  for (const [from, to] of edges) console.log(`  slice${idToNum.get(from)} depends-on slice${idToNum.get(to)}`);

  await checkTreeHashInvariant(repoRoot, branch!, mergeBase, files, order, slices, idToNum);
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

async function checkTreeHashInvariant(
  repoRoot: string,
  branch: string,
  mergeBase: string,
  files: FileSection[],
  order: string[],
  slices: Map<string, Hunk[]>,
  idToNum: Map<string, number>,
) {
  const expected = git(["rev-parse", `${branch}^{tree}`], repoRoot).trim();
  const tmpDir = mkdtempSync(join(tmpdir(), "drip-m0-"));
  const indexFile = join(tmpDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  try {
    git(["read-tree", mergeBase], repoRoot, env);

    for (const id of order) {
      const hunksInSlice = new Set(slices.get(id)!.map((h) => h.index));
      for (const file of files) {
        const selected = file.hunks.filter((h) => hunksInSlice.has(h.index));
        if (!selected.length) continue;
        const patch = file.header + selected.map((h) => h.raw).join("");
        const patchFile = join(tmpDir, "patch.diff");
        writeFileSync(patchFile, patch);
        try {
          git(["apply", "--cached", "--recount", patchFile], repoRoot, env);
        } catch (e) {
          console.error(`\nINVARIANT: FAIL — could not apply slice${idToNum.get(id)} to ${file.path}`);
          console.error(String(e));
          process.exit(1);
        }
      }
    }

    const actual = git(["write-tree"], repoRoot, env).trim();
    if (actual === expected) {
      console.log(`\nINVARIANT: PASS (tree ${actual})`);
    } else {
      console.error(`\nINVARIANT: FAIL — expected ${expected}, got ${actual}`);
      process.exit(1);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
