import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { CoarsenResult } from "./coarsen";
import { DripError } from "./errors";
import type { Database } from "bun:sqlite";
import type { GitBackend } from "./git-backend";
import { materializeFlatFirst } from "./materialize";
import { groupKeyOf, topoSort, type Hunk, type PlanResult } from "./planner";
import type { PushUnits } from "./push";
import { EMPTY_PROFILES, unknownProfileMessage, type ProfileSet } from "./profiles";
import { gitPath } from "./repo";
import { verifyTreeHash } from "./verify";
import { runManifestVerification, type VerificationRun } from "./verification";
import { isCodeFile } from "./workspace";

// Semantic projection manifest (issue #9).
//
// Symbol slicing is a good atomic substrate and a bad source of human review
// units: a real appeals branch produced 161 atomic slices, and no graph
// heuristic recovered the ~8 behavioural changes a reviewer actually cares
// about. The missing layer isn't another heuristic — it's an explicit, durable
// statement of intent that something outside drip (an agent, a human, both)
// proposes and drip then validates and materializes deterministically.
//
// So: drip owns validation and materialization, and nothing else. The manifest
// is inert until explicitly passed to `validate-plan` or `push --manifest`,
// and there is no AI in this process — same boundary as docs/adr/0009.

const ProjectionEntry = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "projection id must be usable in a git branch name (letters, digits, '.', '_', '-')"),
  title: z.string().optional(),
  intent: z.string().optional(),
  // Members and prerequisites are selectors, not ordinals — see resolveSelector.
  atomicSlices: z.array(z.string()).default([]),
  glue: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  // A named command set from the repository's own profiles file, instead of
  // repeating the same strings in every projection (issue #19). Resolved to
  // ordinary commands during validation — nothing downstream knows the
  // difference. Mutually exclusive with an inline `verification` list.
  verificationProfile: z.string().nullable().optional(),
  // Declaring no checks is allowed, but it has to be a decision someone made
  // rather than a field nobody filled in (issue #10).
  verificationReason: z.string().nullable().optional(),
  oversizeReason: z.string().nullable().optional(),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  sourceBranch: z.string().optional(),
  base: z.string().optional(),
  budgets: z
    .object({
      files: z.number().int().positive().optional(),
      hunks: z.number().int().positive().optional(),
      changedLines: z.number().int().positive().optional(),
    })
    .optional(),
  projections: z.array(ProjectionEntry).min(1),
  defer: z.array(z.object({ slice: z.string(), reason: z.string().min(1) })).default([]),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export type Finding = {
  severity: "error" | "warning";
  code:
    | "unknown-selector"
    | "unknown-dependency"
    | "duplicate-id"
    | "duplicate-assignment"
    | "unassigned-slice"
    | "manifest-cycle"
    | "dependency-removed"
    | "glue-not-reachable"
    | "oversize"
    | "apply-failure"
    | "tree-hash-mismatch"
    | "no-verification"
    | "verification-waived"
    | "verification-failed"
    // reusable verification profiles — see profiles.ts / docs/adr/0024
    | "unknown-verification-profile"
    | "verification-profile-conflict"
    // a review candidate without stated intent is a bucket — see docs/adr/0025
    | "no-intent"
    | "ordinal-selector"
    | "branch-mismatch"
    // adoption of a pre-existing PR — see adopt.ts / docs/adr/0020
    | "adopt-mismatch"
    | "adopt-replay-failed"
    | "adopt-pr-state"
    | "adopt-head-mismatch"
    | "adopt-conflict"
    | "base-disagreement";
  projection: string | null;
  message: string;
};

export type ResolvedProjection = {
  id: string;
  title: string;
  intent: string | null;
  sliceIds: string[]; // atomic members, including glue assigned here
  glueSliceIds: string[];
  dependsOn: string[]; // declared, plus any widened-in atomic dependency
  files: string[];
  hunkCount: number;
  changedLines: number;
  /** the commands that will run — resolved from `verificationProfile` when one is named */
  verification: string[];
  /** the profile those commands came from, or null when they were listed inline */
  verificationProfile: string | null;
  verificationReason: string | null;
  oversizeReason: string | null;
};

export type ResolvedManifest = {
  manifest: Manifest;
  projections: ResolvedProjection[];
  order: string[]; // projection ids, topological
  units: Map<string, Hunk[]>;
  edges: [string, string][]; // [dependent id, prerequisite id]
  deferred: { sliceId: string; label: string; reason: string; hunks: Hunk[] }[];
  findings: Finding[];
  ok: boolean;
};

// Where a manifest lives when nobody says otherwise.
//
// Two locations, checked in this order:
//
//   .drip/projections/<branch>.json        — in the working tree, committable
//   <gitdir>/drip/projections/<branch>.json — private to the clone
//
// The tracked location comes first on purpose. An approved review plan is a
// document a team argues about, reviews and keeps — unlike overrides, which are
// one person's local boundary corrections and belong in `.git/drip.db`
// (docs/adr/0002). The private location exists for the solo case where you
// don't want the plan in the branch's own diff.
export function manifestCandidates(repoRoot: string, branch: string): string[] {
  return [join(repoRoot, ".drip", "projections", `${branch}.json`), join(gitPath(repoRoot, "drip/projections"), `${branch}.json`)];
}

export function findManifest(repoRoot: string, branch: string): string | null {
  return manifestCandidates(repoRoot, branch).find((p) => existsSync(p)) ?? null;
}

// A starting-point manifest built from the coarsened projections, for a human
// or an agent to edit. Deliberately *not* a finished plan: the ids are
// mechanical and there is no `intent`, because inventing product intent is
// exactly the thing drip has no basis to do (docs/adr/0018). It exists so the
// author edits a valid, complete skeleton instead of hand-writing selectors.
export function emitManifest(coarse: CoarsenResult, plan: PlanResult, opts: { branch: string; base: string }): Manifest {
  const used = new Map<string, number>();
  const dedupe = (slug: string) => {
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    return n === 1 ? slug : `${slug}-${n}`;
  };
  const idFor = (p: CoarsenResult["projections"][number]) => {
    // A dependency-manifest projection named after whichever lockfile sorted
    // first ("bun") reads as a package name, not a change. Name it for what it
    // is; the directory heuristic below is only sensible for source.
    const reasons = new Set(p.sliceIds.flatMap((s) => plan.fallbackGroups.get(s)?.reasons ?? []));
    if (p.fallbackOnly && reasons.size === 1 && reasons.has("dependency-manifest")) return dedupe("deps");

    const dirs = p.files.map((f) => f.split("/").slice(0, -1));
    const common: string[] = [];
    if (dirs.length) {
      for (let i = 0; i < dirs[0]!.length; i++) {
        const seg = dirs[0]![i]!;
        if (dirs.every((d) => d[i] === seg)) common.push(seg);
        else break;
      }
    }
    const basis = common.length ? common.join("-") : (p.files[0] ?? p.label).split("/").pop()!.replace(/\.[^.]+$/, "");
    return dedupe(basis.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || p.label);
  };

  const idByLabel = new Map(coarse.projections.map((p) => [p.label, idFor(p)]));
  return ManifestSchema.parse({
    version: 1,
    sourceBranch: opts.branch,
    base: opts.base,
    projections: coarse.projections.map((p) => ({
      id: idByLabel.get(p.label)!,
      title: `drip: ${idByLabel.get(p.label)!}`,
      // Every group key of every member slice: more verbose than one key per
      // slice, but it survives a slice being split apart by a later replan.
      atomicSlices: [...new Set(p.sliceIds.flatMap((s) => plan.slices.get(s)!.map(groupKeyOf)))].sort(),
      dependsOn: p.prerequisites.map((label) => idByLabel.get(label)!).sort(),
    })),
  });
}

export function loadManifest(path: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new DripError(`could not read manifest ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new DripError(`manifest ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new DripError(`manifest ${path} does not match the v1 schema:\n${issues}`);
  }
  return result.data;
}

// A manifest member selector is either a durable group key ("file::Symbol",
// "file::(file)") or an ordinal slice label ("slice17"). Ordinals are accepted
// because that's what `plan` prints and what an agent will reach for first,
// but they are *not* durable — slice numbering is derived and shifts whenever
// the branch changes — so using one earns a warning telling you what to write
// instead.
function resolveSelector(plan: PlanResult, selector: string): { sliceId: string; ordinal: boolean } | null {
  if (/^slice\d+$/.test(selector)) {
    for (const [id, num] of plan.idToNum) if (`slice${num}` === selector) return { sliceId: id, ordinal: true };
    return null;
  }
  if (selector.includes("::")) {
    for (const [id, hunks] of plan.slices) if (hunks.some((h) => groupKeyOf(h) === selector)) return { sliceId: id, ordinal: false };
    return null;
  }
  return null;
}

const countChangedLines = (hunks: Hunk[]) =>
  hunks.reduce((n, h) => n + h.raw.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length, 0);

export function resolveManifest(
  plan: PlanResult,
  manifest: Manifest,
  opts: {
    branch?: string;
    /** a projection containing code must declare a runnable check; a reason isn't enough (issue #14) */
    requireVerification?: boolean;
    /** a projection must state what change it is, not just which slices it holds (issue #16) */
    requireIntent?: boolean;
    /** the repository's named verification command sets (issue #19); omit for none */
    profiles?: ProfileSet;
    /** only used to name the file a missing profiles document should live at */
    repoRoot?: string;
  } = {},
): ResolvedManifest {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], code: Finding["code"], projection: string | null, message: string) =>
    findings.push({ severity, code, projection, message });

  if (!plan.order) throw new DripError("cannot validate a manifest against a plan with a dependency cycle — resolve the cycle first");
  const label = (id: string) => `slice${plan.idToNum.get(id)}`;

  if (opts.branch && manifest.sourceBranch && manifest.sourceBranch !== opts.branch) {
    add("warning", "branch-mismatch", null, `manifest sourceBranch is '${manifest.sourceBranch}' but this run is for '${opts.branch}'`);
  }

  const ids = manifest.projections.map((p) => p.id);
  for (const id of new Set(ids)) {
    if (ids.filter((x) => x === id).length > 1) add("error", "duplicate-id", id, `projection id '${id}' is declared more than once`);
  }
  const known = new Set(ids);

  // --- resolve members -------------------------------------------------------
  const assignedTo = new Map<string, string>(); // sliceId -> projection id
  const glueRefs = new Map<string, string[]>(); // sliceId -> projection ids referencing it as glue
  const membersOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  const glueOf = new Map<string, string[]>(ids.map((id) => [id, []]));

  const resolveInto = (projId: string, selectors: string[], kind: "atomicSlices" | "glue") => {
    for (const selector of selectors) {
      const hit = resolveSelector(plan, selector);
      if (!hit) {
        // This doubles as the migration report: after a replan, selectors that
        // no longer match are exactly the approved boundaries needing review.
        add("error", "unknown-selector", projId, `${kind} selector '${selector}' matched no slice in the current plan`);
        continue;
      }
      if (hit.ordinal) {
        const durable = [...new Set(plan.slices.get(hit.sliceId)!.map(groupKeyOf))].sort()[0];
        add("warning", "ordinal-selector", projId, `'${selector}' is an ordinal slice label and won't survive replanning — prefer '${durable}'`);
      }
      if (kind === "glue") {
        glueOf.get(projId)!.push(hit.sliceId);
        glueRefs.set(hit.sliceId, [...(glueRefs.get(hit.sliceId) ?? []), projId]);
        continue;
      }
      const existing = assignedTo.get(hit.sliceId);
      if (existing && existing !== projId) {
        add("error", "duplicate-assignment", projId, `${label(hit.sliceId)} ('${selector}') is also assigned to projection '${existing}'`);
        continue;
      }
      assignedTo.set(hit.sliceId, projId);
      membersOf.get(projId)!.push(hit.sliceId);
    }
  };

  for (const entry of manifest.projections) {
    resolveInto(entry.id, entry.atomicSlices, "atomicSlices");
    for (const dep of entry.dependsOn) {
      if (!known.has(dep)) add("error", "unknown-dependency", entry.id, `dependsOn references unknown projection '${dep}'`);
    }
  }
  for (const entry of manifest.projections) resolveInto(entry.id, entry.glue, "glue");

  const deferred: ResolvedManifest["deferred"] = [];
  for (const d of manifest.defer) {
    const hit = resolveSelector(plan, d.slice);
    if (!hit) {
      add("error", "unknown-selector", null, `defer selector '${d.slice}' matched no slice in the current plan`);
      continue;
    }
    deferred.push({ sliceId: hit.sliceId, label: label(hit.sliceId), reason: d.reason, hunks: plan.slices.get(hit.sliceId)! });
  }
  const deferredIds = new Set(deferred.map((d) => d.sliceId));

  // --- glue assignment -------------------------------------------------------
  // Glue is a *reference*, not an exclusive claim: several projections may each
  // need the same small import/DTO/fixture change. It is assigned once — to an
  // explicit atomicSlices assignment if there is one, else to the first
  // referencing projection in declaration order — and every other referencing
  // projection must then have that one in its prerequisite closure.
  for (const [sliceId, refs] of glueRefs) {
    if (assignedTo.has(sliceId)) continue;
    const owner = refs[0]!;
    assignedTo.set(sliceId, owner);
    membersOf.get(owner)!.push(sliceId);
  }

  // --- unassigned ------------------------------------------------------------
  for (const sliceId of plan.order) {
    if (assignedTo.has(sliceId) || deferredIds.has(sliceId)) continue;
    const durable = [...new Set(plan.slices.get(sliceId)!.map(groupKeyOf))].sort()[0];
    add(
      "error",
      "unassigned-slice",
      null,
      `${label(sliceId)} ('${durable}') is in no projection and not deferred — assign it or add it to defer with a reason`,
    );
  }

  // --- manifest DAG ----------------------------------------------------------
  const declared: [string, string][] = [];
  for (const entry of manifest.projections) for (const dep of entry.dependsOn) if (known.has(dep)) declared.push([entry.id, dep]);

  let order = topoSort(ids, declared);
  if (!order) {
    add("error", "manifest-cycle", null, "the manifest's dependsOn graph contains a cycle");
    order = ids; // keep going so the rest of the report is still useful
  }

  // Transitive closure over declared dependencies.
  const closure = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const id of order) {
    const acc = closure.get(id)!;
    for (const [from, to] of declared) {
      if (from !== id) continue;
      acc.add(to);
      for (const t of closure.get(to) ?? []) acc.add(t);
    }
  }

  // --- dependency agreement --------------------------------------------------
  // The manifest may *widen* a dependency (declare one the atomic DAG didn't
  // imply) but never drop one: an atomic edge crossing a projection boundary is
  // a hard ordering constraint discovered from the code itself.
  const projOf = (sliceId: string) => assignedTo.get(sliceId) ?? null;
  const reported = new Set<string>();
  for (const [from, to] of plan.edges) {
    const pf = projOf(from);
    const pt = projOf(to);
    // Deferring a slice another projection depends on isn't a scheduling
    // choice, it's a broken PR: the dependent would be pushed without
    // something it needs.
    if (pf && !pt && deferredIds.has(to)) {
      const key = `defer ${pf} ${to}`;
      if (!reported.has(key)) {
        reported.add(key);
        add("error", "dependency-removed", pf, `depends on ${label(to)}, which is deferred — it can't be deferred while '${pf}' needs it`);
      }
      continue;
    }
    if (!pf || !pt || pf === pt) continue;
    if (closure.get(pf)?.has(pt)) continue;
    const key = `${pf} ${pt}`;
    if (reported.has(key)) continue;
    reported.add(key);
    add(
      "error",
      "dependency-removed",
      pf,
      `${label(from)} depends on ${label(to)}, so '${pf}' must depend on '${pt}' (directly or transitively) — add it to dependsOn`,
    );
  }

  // --- glue reachability -----------------------------------------------------
  for (const [sliceId, refs] of glueRefs) {
    const owner = assignedTo.get(sliceId)!;
    for (const ref of refs) {
      if (ref === owner) continue;
      if (closure.get(ref)?.has(owner)) continue;
      add(
        "error",
        "glue-not-reachable",
        ref,
        `glue ${label(sliceId)} lives in '${owner}', which is not in '${ref}'s prerequisite closure — add '${owner}' to dependsOn`,
      );
    }
  }

  // --- assemble --------------------------------------------------------------
  const units = new Map<string, Hunk[]>();
  const projections: ResolvedProjection[] = [];
  const entryById = new Map(manifest.projections.map((e) => [e.id, e]));

  for (const id of order) {
    const entry = entryById.get(id)!;
    const sliceIds = [...new Set(membersOf.get(id)!)].sort((a, b) => plan.order!.indexOf(a) - plan.order!.indexOf(b));
    const hunks = sliceIds.flatMap((s) => plan.slices.get(s)!);
    units.set(id, hunks);

    const files = [...new Set(hunks.map((h) => h.file))].sort();
    const changedLines = countChangedLines(hunks);
    const budgets = manifest.budgets;
    const over: string[] = [];
    if (budgets?.files && files.length > budgets.files) over.push(`${files.length} files > ${budgets.files}`);
    if (budgets?.hunks && hunks.length > budgets.hunks) over.push(`${hunks.length} hunks > ${budgets.hunks}`);
    if (budgets?.changedLines && changedLines > budgets.changedLines) over.push(`${changedLines} changed lines > ${budgets.changedLines}`);
    if (over.length && !entry.oversizeReason) {
      add("error", "oversize", id, `exceeds the review budget (${over.join(", ")}) — shrink it or set oversizeReason`);
    }
    // "This PR is independently reviewable" is a claim about it being runnable,
    // and an empty `verification` makes that claim untested. Allowed, but only
    // as a stated decision — a warning by default, an error under --strict.
    //
    // Under --require-verification the exemption stops applying to projections
    // that contain code: a prose reason is not a check, and a mechanically
    // split projection can reconstruct the tree exactly and still not compile
    // because the symbols it needs landed in a different one (issue #14).
    // Docs-, config- and lockfile-only projections keep the old rule — there
    // is nothing there for a typecheck to have an opinion about.
    // --- verification commands: inline, or resolved from a named profile -----
    // A profile is a lookup, not a merge: a projection that both names one and
    // lists its own commands has two answers to "what runs here", and picking
    // either silently is how a projection ends up running something its author
    // didn't write. Resolution is reported alongside the commands, so the
    // report never shows a command whose origin isn't visible.
    const profiles = opts.profiles ?? EMPTY_PROFILES;
    const profileName = entry.verificationProfile ?? null;
    let commands = entry.verification;
    let profileResolved: string | null = null;
    if (profileName) {
      if (entry.verification.length) {
        add(
          "error",
          "verification-profile-conflict",
          id,
          `declares both verificationProfile '${profileName}' and its own verification commands — keep one: the profile for the shared case, the inline list for a one-off`,
        );
        commands = entry.verification;
      } else {
        const hit = profiles.byName.get(profileName);
        if (!hit) {
          add("error", "unknown-verification-profile", id, unknownProfileMessage(profiles, profileName, opts.repoRoot));
          commands = [];
        } else {
          commands = hit.commands;
          profileResolved = profileName;
        }
      }
    }

    // A projection is a claim about *what change this is*. Without that it's a
    // set of slices with an id, which is the thing coarsening already produces
    // and the reason the manifest layer exists at all (issue #16). A warning by
    // default — an emitted skeleton is meant to be edited, not rejected — and
    // an error under --require-intent or --strict.
    if (!entry.intent?.trim()) {
      add(
        opts.requireIntent ? "error" : "warning",
        "no-intent",
        id,
        "states no intent — say what behavioural change this PR is, in a sentence a reviewer can check the diff against",
      );
    }

    const codeFiles = files.filter(isCodeFile);
    if (!commands.length && !profileName) {
      if (opts.requireVerification && codeFiles.length) {
        add(
          "error",
          "verification-waived",
          id,
          `contains ${codeFiles.length} code file(s) and declares no verification command` +
            (entry.verificationReason ? ` — verificationReason ("${entry.verificationReason}") does not satisfy --require-verification` : "") +
            ": a projection can reconstruct the mega branch's tree and still not typecheck on its own",
        );
      } else if (!entry.verificationReason) {
        add("warning", "no-verification", id, "declares no verification commands — add some, or set verificationReason to say why none apply");
      }
    }

    projections.push({
      id,
      title: entry.title ?? `drip: ${id}`,
      intent: entry.intent ?? null,
      sliceIds,
      glueSliceIds: [...new Set(glueOf.get(id)!)],
      dependsOn: entry.dependsOn.filter((d) => known.has(d)),
      files,
      hunkCount: hunks.length,
      changedLines,
      verification: commands,
      verificationProfile: profileResolved,
      verificationReason: entry.verificationReason ?? null,
      oversizeReason: entry.oversizeReason ?? null,
    });
  }

  return {
    manifest,
    projections,
    order,
    units,
    edges: declared,
    deferred,
    findings,
    ok: !findings.some((f) => f.severity === "error"),
  };
}

// Everything the branch contains, in an order the tree-hash check can consume:
// the approved projections, then a trailing bucket of whatever was deferred.
// Never pushed — deferred work has no PR by definition — but it has to be in
// the tree check or the check would be proving something weaker than it claims.
export const DEFERRED_UNIT = "(deferred)";

export function verificationUnits(resolved: ResolvedManifest): {
  order: string[];
  slices: Map<string, Hunk[]>;
  idToNum: Map<string, number>;
} {
  const order = [...resolved.order];
  const slices = new Map(resolved.units);
  if (resolved.deferred.length) {
    order.push(DEFERRED_UNIT);
    slices.set(DEFERRED_UNIT, resolved.deferred.flatMap((d) => d.hunks));
  }
  return { order, slices, idToNum: new Map(order.map((id, i) => [id, i])) };
}

// The two checks that need git: does each projection actually apply on its
// declared prerequisite closure, and does the whole graph still reconstruct the
// mega-branch tree. Deliberately reuses flat-first materialization and the
// existing tree-hash verifier rather than reimplementing either.
export async function validateManifestAgainstGit(opts: {
  git: GitBackend;
  repoRoot: string;
  branch: string;
  mergeBase: string;
  plan: PlanResult;
  resolved: ResolvedManifest;
  /** tree-ish the projections must reconstruct; defaults to `branch` (see src/source.ts) */
  sourceRef?: string;
  /** omit to skip executing verification commands (`--no-manifest-check`) */
  db?: Database;
  runVerification?: boolean;
}): Promise<{ findings: Finding[]; verification: VerificationRun[] }> {
  const { git, repoRoot, branch, mergeBase, plan, resolved } = opts;
  const findings: Finding[] = [];
  const verification: VerificationRun[] = [];
  if (!resolved.units.size) return { findings, verification };

  const materialized = await materializeFlatFirst({
    git,
    repoRoot,
    mergeBase,
    files: plan.files,
    order: resolved.order,
    slices: resolved.units,
    edges: resolved.edges,
    label: (id) => id,
  });
  for (const m of materialized) {
    if (m.commit) {
      if (m.widened) {
        findings.push({
          severity: "warning",
          code: "apply-failure",
          projection: m.sliceId,
          message: `applies only after widening its prerequisites to ${m.prerequisites.join(", ")} — the declared dependsOn understates what it needs`,
        });
      }
      continue;
    }
    findings.push({
      severity: "error",
      code: "apply-failure",
      projection: m.sliceId,
      message: `does not apply on its declared prerequisite closure: ${m.applyError ?? "unknown error"}`,
    });
  }

  // The invariant is "the approved projections *plus* whatever was explicitly
  // deferred reconstruct the mega branch" — deferring is a decision about which
  // PR something lands in, never a licence to drop it. Checking the projections
  // alone would force a choice between failing every manifest that defers
  // anything and downgrading the one check that actually proves nothing is
  // lost; verifying with the deferred remainder appended keeps it a hard check.
  const units = verificationUnits(resolved);
  const tree = await verifyTreeHash({
    git,
    repoRoot,
    branch,
    mergeBase,
    files: plan.files,
    order: units.order,
    slices: units.slices,
    // A worktree plan's projections reconstruct the working tree, not the
    // branch tip — same claim, different tip (docs/adr/0021).
    sourceRef: opts.sourceRef,
    excluded: plan.excluded,
  });
  if (!tree.pass) {
    findings.push({
      severity: "error",
      code: "tree-hash-mismatch",
      projection: null,
      message: `${tree.message}${resolved.deferred.length ? " (checked with the deferred slices appended, so this is a real loss, not the deferral)" : ""}`,
    });
  }

  // Only worth running commands once the projections are structurally sound and
  // each one actually applies — otherwise every command fails for the same
  // upstream reason and the report buries the real cause.
  const applied = new Map(materialized.filter((m) => m.commit).map((m) => [m.sliceId, m.commit!]));
  if (opts.runVerification && opts.db && !findings.some((f) => f.severity === "error")) {
    const byId = new Map(resolved.projections.map((p) => [p.id, p]));
    verification.push(
      ...runManifestVerification({
        git,
        db: opts.db,
        repoRoot,
        branch,
        commits: resolved.order
          .filter((id) => applied.has(id))
          .map((id) => ({ projection: id, commit: applied.get(id)!, commands: byId.get(id)?.verification ?? [] })),
      }),
    );
    for (const run of verification.filter((r) => !r.passed)) {
      findings.push({
        severity: "error",
        code: "verification-failed",
        projection: run.projection,
        message: `\`${run.command}\` failed (exit ${run.exitCode ?? "?"}) against this projection's own tree — output: ${run.outputPath}`,
      });
    }
  }
  return { findings, verification };
}

// Correspondence identity for a manifest projection is the *approved semantic
// boundary* — its manifest id — not the ordinal atomic slices it happens to
// contain today. That's the whole point: replanning may renumber every slice
// underneath a projection without the PR losing its identity. Prefixed so it
// can never collide with a computeSliceSignature hash.
export const manifestSignature = (projectionId: string) => `manifest:${projectionId}`;

export function unitsFromManifest(resolved: ResolvedManifest, branch: string): PushUnits {
  const byId = new Map(resolved.projections.map((p) => [p.id, p]));
  return {
    order: resolved.order,
    slices: resolved.units,
    edges: resolved.edges,
    label: (id) => id,
    signature: manifestSignature,
    title: (id) => byId.get(id)!.title,
    body: (id) => {
      const p = byId.get(id)!;
      return [
        p.intent ? p.intent : `Auto-generated by \`drip push --manifest\` for mega branch \`${branch}\`.`,
        "",
        `Projection \`${p.id}\` — ${p.sliceIds.length} atomic slice(s)${p.glueSliceIds.length ? `, ${p.glueSliceIds.length} of them glue` : ""}.`,
        ...(p.dependsOn.length ? ["", `Depends on: ${p.dependsOn.join(", ")}`] : []),
        ...(p.verification.length ? ["", "Verification:", ...p.verification.map((v) => `- \`${v}\``)] : []),
        ...(p.oversizeReason ? ["", `Oversize, accepted: ${p.oversizeReason}`] : []),
        "",
        "Files touched:",
        ...p.files.map((f) => `- ${f}`),
      ].join("\n");
    },
  };
}

export function manifestReportToJson(resolved: ResolvedManifest, extra: Finding[] = [], verification: VerificationRun[] = []): object {
  const findings = [...resolved.findings, ...extra];
  return {
    ok: !findings.some((f) => f.severity === "error"),
    projectionCount: resolved.projections.length,
    deferred: resolved.deferred.map((d) => ({ slice: d.label, reason: d.reason })),
    projections: resolved.projections.map((p) => ({
      id: p.id,
      title: p.title,
      intent: p.intent,
      slices: p.sliceIds.length,
      glue: p.glueSliceIds.length,
      dependsOn: p.dependsOn,
      files: p.files,
      hunks: p.hunkCount,
      changedLines: p.changedLines,
      verification: p.verification,
      verificationProfile: p.verificationProfile,
      verificationReason: p.verificationReason,
      oversizeReason: p.oversizeReason,
    })),
    verificationRuns: verification.map((r) => ({
      projection: r.projection,
      command: r.command,
      passed: r.passed,
      exitCode: r.exitCode,
      outputPath: r.outputPath,
      durationMs: r.durationMs,
      cached: r.cached,
    })),
    findings,
  };
}

export function printManifestReport(resolved: ResolvedManifest, extra: Finding[] = [], verification: VerificationRun[] = [], strict = false): void {
  const findings = [...resolved.findings, ...extra];
  console.log(`MANIFEST (${resolved.projections.length} projections):`);
  for (const p of resolved.projections) {
    console.log(`  ${p.id} — ${p.title}`);
    if (p.intent) console.log(`    intent: ${p.intent}`);
    console.log(`    ${p.sliceIds.length} slice(s)${p.glueSliceIds.length ? ` (${p.glueSliceIds.length} glue)` : ""}, ${p.files.length} file(s), ${p.hunkCount} hunk(s), ${p.changedLines} changed line(s)`);
    if (p.dependsOn.length) console.log(`    requires: ${p.dependsOn.join(", ")}`);
    // The profile is named next to the commands it resolved to: a reader of
    // this report should never have to open a second file to learn what runs.
    if (p.verification.length) console.log(`    verify: ${p.verification.join(" && ")}${p.verificationProfile ? `  (profile: ${p.verificationProfile})` : ""}`);
    if (p.oversizeReason) console.log(`    oversize (accepted): ${p.oversizeReason}`);
  }

  if (resolved.deferred.length) {
    console.log("\nDEFERRED (deliberately not in any projection):");
    for (const d of resolved.deferred) console.log(`  ${d.label}: ${d.reason}`);
  }

  if (verification.length) {
    console.log("\nVERIFICATION:");
    for (const r of verification) {
      const status = r.passed ? (r.cached ? "PASS (cached)" : "PASS") : `FAIL (exit ${r.exitCode ?? "?"})`;
      console.log(`  ${r.projection}: \`${r.command}\` — ${status}${r.cached ? "" : ` in ${r.durationMs}ms`}`);
      if (!r.passed && r.outputPath) console.log(`    output: ${r.outputPath}`);
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  for (const [title, list] of [
    ["WARNINGS", warnings],
    ["ERRORS", errors],
  ] as const) {
    if (!list.length) continue;
    console.log(`\n${title}:`);
    for (const f of list) console.log(`  [${f.code}]${f.projection ? ` ${f.projection}:` : ""} ${f.message}`);
  }

  // Under --strict a warning is a failure, so the summary must say FAIL —
  // printing PASS next to a non-zero exit is worse than no summary at all.
  const failed = errors.length > 0 || (strict && warnings.length > 0);
  const counts = `${errors.length} error(s), ${warnings.length} warning(s)${strict ? ", --strict" : ""}`;
  console.log(failed ? `\nMANIFEST: FAIL (${counts})` : `\nMANIFEST: PASS (${warnings.length} warning(s))`);
}

export function writeManifest(path: string, manifest: Manifest, opts: { force?: boolean } = {}): void {
  if (existsSync(path) && !opts.force) {
    throw new DripError(`${path} already exists — pass --force to overwrite (this would discard any hand-written intent in it)`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
