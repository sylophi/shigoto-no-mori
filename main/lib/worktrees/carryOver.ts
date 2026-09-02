// Configure-view reads for carry-over, spanning every checkout of the
// project. Entries are root-relative, so the primary and each worktree
// are all candidates. The CLI applies the same idea at creation
// (carryOverSources in cli/carryover.go looks in the base ref's
// worktree, then the primary, then the rest). Checkouts are listed
// primary first: when checkouts disagree on whether a name is a file
// or a folder, the first one holding it decides.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeIgnoreMatcher } from "@shared/gitPaths";
import type { CarryOverCandidate, CarryOverStat } from "@shared/schemas";
import { listIgnoredPaths } from "../git/branches";
import {
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "../git/worktrees";
import { ttlMapCache } from "../util/ttlCache";

export type CarryOverCheckout = Pick<
  WorktreeIdentity,
  "name" | "path" | "isPrimary"
>;

// Falls back to the primary alone when the worktree list can't be read.
// A bare repo flags no identity as primary, so the first checkout stands
// in, matching the CLI (cli/gitx.go crowns index 0).
export async function listCarryOverCheckouts(
  projectId: string,
  projectPath: string,
): Promise<CarryOverCheckout[]> {
  let identities: WorktreeIdentity[];
  try {
    identities = await listWorktreeIdentities(projectId, projectPath);
  } catch {
    identities = [];
  }
  if (identities.length === 0) {
    return [{ name: "primary", path: projectPath, isPrimary: true }];
  }
  const checkouts = identities.toSorted(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name),
  );
  return checkouts[0].isPrimary
    ? checkouts
    : [{ ...checkouts[0], isPrimary: true }, ...checkouts.slice(1)];
}

// The picker re-lists on every folder step while the ignored set of a
// checkout barely changes. One walk per checkout every few seconds is
// plenty.
const ignoredPathsCache = ttlMapCache<string, string[]>(
  10_000,
  listIgnoredPaths,
);

// Union of `relative` across checkouts. A checkout without the folder
// (or one git can't read) contributes nothing. Only when none can list
// it does this throw. A name is offered as ignored only when every
// checkout holding it ignores it: a file tracked in one checkout would
// collide with git's own copy at creation.
export async function listCarryOverCandidates(
  projectId: string,
  projectPath: string,
  relative: string,
): Promise<CarryOverCandidate[]> {
  const checkouts = await listCarryOverCheckouts(projectId, projectPath);
  const listed = await Promise.all(
    checkouts.map(async (checkout) => {
      try {
        const [entries, ignored] = await Promise.all([
          readdir(join(checkout.path, relative), { withFileTypes: true }),
          ignoredPathsCache.get(checkout.path),
        ]);
        return { checkout, entries, isIgnored: makeIgnoreMatcher(ignored) };
      } catch {
        return null;
      }
    }),
  );
  if (listed.every((r) => r === null)) {
    throw new Error(`Couldn't read ${relative || "the project root"}`);
  }
  const byName = new Map<string, CarryOverCandidate>();
  for (const result of listed) {
    if (!result) continue;
    for (const entry of result.entries) {
      // .git is worktree metadata, never useful as carry-over.
      if (entry.name === ".git") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      let candidate = byName.get(entry.name);
      if (!candidate) {
        candidate = {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          ignored: true,
          inPrimary: false,
          worktrees: [],
        };
        byName.set(entry.name, candidate);
      }
      candidate.ignored &&= result.isIgnored(path);
      if (result.checkout.isPrimary) candidate.inPrimary = true;
      else candidate.worktrees.push(result.checkout.name);
    }
  }
  // Folders before files, then alphabetical within each group.
  return [...byName.values()].toSorted((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Where each configured path currently exists.
export async function statCarryOverPaths(
  projectId: string,
  projectPath: string,
  paths: string[],
): Promise<Record<string, CarryOverStat>> {
  const checkouts = await listCarryOverCheckouts(projectId, projectPath);
  const stats: Record<string, CarryOverStat> = {};
  await Promise.all(
    paths.map(async (path) => {
      const found = await Promise.all(
        checkouts.map(async (checkout) => {
          try {
            const s = await stat(join(checkout.path, path));
            return { checkout, isDirectory: s.isDirectory() };
          } catch {
            return null;
          }
        }),
      );
      const hits = found.filter((h) => h !== null);
      stats[path] = {
        isDirectory: hits[0]?.isDirectory ?? false,
        inPrimary: hits.some((h) => h.checkout.isPrimary),
        worktrees: hits
          .filter((h) => !h.checkout.isPrimary)
          .map((h) => h.checkout.name),
      };
    }),
  );
  return stats;
}
