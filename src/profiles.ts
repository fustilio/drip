import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DripError } from "./errors";
import { gitPath } from "./repo";

// Reusable verification profiles (issue #19).
//
// A projection's `verification` commands are executed against its own
// materialized tree (docs/adr/0019), which is what makes "this PR is
// independently runnable" a checked claim rather than a stated one. In practice
// a repository has two or three real answers — "typecheck the workspace", "run
// the API package's tests" — and every projection in the manifest repeats one
// of them verbatim. Repetition is how a manifest ends up with one projection
// running `pnpm -r typecheck` and its neighbour running `pnpm typecheck`, which
// is a difference nobody intended and nobody can see.
//
// So the command sets get a name and one definition. The profile file is a
// repository-local document like the manifest is (and like overrides are not —
// docs/adr/0002): committable, diffable, argued about once.
//
// What this deliberately is *not*: a place drip picks a default from. A profile
// applies only where a projection names it. Nothing here composes a command,
// infers one from the workspace, or runs anything — resolution is a string
// lookup, and the resolved commands go down exactly the same execution path
// inline ones already did.

const ProfileEntry = z.object({
  description: z.string().optional(),
  commands: z.array(z.string().min(1)).min(1),
});

export const VerificationProfilesSchema = z.object({
  version: z.literal(1),
  profiles: z.record(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "profile name must be letters, digits, '.', '_' or '-'"),
    ProfileEntry,
  ),
});

export type VerificationProfile = { name: string; commands: string[]; description: string | null };

export type ProfileSet = {
  /** where the profiles came from, or null when the repo declares none */
  path: string | null;
  byName: Map<string, VerificationProfile>;
};

export const EMPTY_PROFILES: ProfileSet = { path: null, byName: new Map() };

// Same two-location convention as the manifest (docs/adr/0018): the tracked
// path first, because a team's verification vocabulary is part of the review
// plan they keep, and the private one for the solo case.
export function profileCandidates(repoRoot: string): string[] {
  return [join(repoRoot, ".drip", "verification.json"), join(gitPath(repoRoot, "drip"), "verification.json")];
}

export function findProfiles(repoRoot: string): string | null {
  return profileCandidates(repoRoot).find((p) => existsSync(p)) ?? null;
}

// A malformed profiles file is an error even when nothing references it. The
// alternative — ignoring it and reporting "unknown profile 'ts'" later — sends
// the reader to the manifest to debug a typo that is in the profile file.
export function loadProfiles(repoRoot: string): ProfileSet {
  const path = findProfiles(repoRoot);
  if (!path) return EMPTY_PROFILES;
  return loadProfilesFrom(path);
}

export function loadProfilesFrom(path: string): ProfileSet {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new DripError(`could not read verification profiles ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new DripError(`verification profiles ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = VerificationProfilesSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new DripError(`verification profiles ${path} do not match the v1 schema:\n${issues}`);
  }
  const byName = new Map<string, VerificationProfile>();
  for (const [name, entry] of Object.entries(result.data.profiles)) {
    byName.set(name, { name, commands: entry.commands, description: entry.description ?? null });
  }
  return { path, byName };
}

// The message a projection gets when its `verificationProfile` doesn't resolve.
// Actionable means naming the file that was read (or the one that should exist)
// and what it does define — an unknown-profile error whose fix is a typo
// correction should not require going and reading the file to find that out.
export function unknownProfileMessage(profiles: ProfileSet, name: string, repoRoot?: string): string {
  if (!profiles.path) {
    const where = repoRoot ? profileCandidates(repoRoot)[0]! : ".drip/verification.json";
    return (
      `references verification profile '${name}', but this repository declares no profiles — ` +
      `create ${where} with {"version": 1, "profiles": {"${name}": {"commands": ["..."]}}}, or list the commands inline`
    );
  }
  const known = [...profiles.byName.keys()].sort();
  return (
    `references verification profile '${name}', which is not defined in ${profiles.path}` +
    (known.length ? ` — defined there: ${known.join(", ")}` : " — that file defines no profiles")
  );
}
