import { buildCommand, buildRouteMap } from "@stricli/core";
import { addOverride, listOverrides, openStore, removeOverride } from "../store";
import { command, repoFlag, resolveRepo, wholeNumber } from "./shared";

// Boundary overrides (docs/adr/0004), keyed by file::QualifiedSymbolPath and
// persisted in the store so they survive replanning.

const addCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string; kind: "force_merge" | "force_split"; selectorA: string; selectorB?: string; note?: string }, branch: string) => {
      const db = openStore(resolveRepo(flags.repo));
      // addOverride validates the selector format and the selectorB presence
      // rules and throws DripError — one place, not duplicated per caller.
      addOverride(db, branch, flags.kind, flags.selectorA, flags.selectorB ?? null, flags.note ?? null);
      console.log(`added ${flags.kind} override for ${branch}`);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch this override applies to", parse: String, placeholder: "branch" }] },
    flags: {
      repo: repoFlag,
      kind: { kind: "enum", values: ["force_merge", "force_split"], brief: "merge two boundaries, or split one" },
      selectorA: { kind: "parsed", parse: String, brief: "file::QualifiedSymbolPath" },
      selectorB: { kind: "parsed", parse: String, brief: "the other side of a force_merge", optional: true },
      note: { kind: "parsed", parse: String, brief: "why, for whoever reads this later", optional: true },
    },
  },
  docs: { brief: "record a boundary decision that survives replanning" },
});

const listCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string }, branch: string) => {
      const overrides = listOverrides(openStore(resolveRepo(flags.repo)), branch);
      if (!overrides.length) {
        console.log(`no overrides for ${branch}`);
        return;
      }
      for (const o of overrides) {
        const pair = o.kind === "force_merge" ? `${o.selectorA} <-> ${o.selectorB}` : o.selectorA;
        console.log(`  [${o.id}] ${o.kind}: ${pair}${o.note ? `  (${o.note})` : ""}`);
      }
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the mega branch", parse: String, placeholder: "branch" }] },
    flags: { repo: repoFlag },
  },
  docs: { brief: "list the boundary overrides recorded for a branch" },
});

const removeCommand = buildCommand({
  loader: async () =>
    command((flags: { repo?: string }, id: number) => {
      const removed = removeOverride(openStore(resolveRepo(flags.repo)), id);
      console.log(removed ? `removed override ${id}` : `no override with id ${id}`);
    }),
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "the override's id, from `drip override list`", parse: wholeNumber("<id>"), placeholder: "id" }] },
    flags: { repo: repoFlag },
  },
  docs: { brief: "drop a boundary override" },
});

export const overrideRoutes = buildRouteMap({
  routes: { add: addCommand, list: listCommand, remove: removeCommand },
  docs: { brief: "boundary overrides that survive replanning" },
});
