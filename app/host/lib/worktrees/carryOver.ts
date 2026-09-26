// Configure-view reads spanning every checkout of the project, for
// carry-over and for the leave-out preset's picker, which unions this
// listing across devices (renderer/hooks/remote/useRepoListing.ts).
// Entries are root-relative, so the primary and each worktree
// are all candidates. The CLI applies the same idea at creation
// (carryOverSources in cli/carryover.go looks in the base ref's
// worktree, then the primary, then the rest). Checkouts are listed
// primary first: when checkouts disagree on whether a name is a file
// or a folder, the first one holding it decides.
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeIgnoreMatcher, normalizeRelPath } from "@shared/git/gitPaths";
import type { CarryOverCandidate, CarryOverStat } from "@shared/schemas";
import type { SyncWorktreeFolderEntry } from "@shared/ipc/modules/sync";
import { listIgnoredPaths } from "../git/branches";
import { chunked, runLenient } from "../git/core";
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
// in.
export async function listCarryOverCheckouts(
  projectId: string,
  projectPath: string,
): Promise<CarryOverCheckout[]> {
  const identities = await listWorktreeIdentities(projectId).catch(
    (): WorktreeIdentity[] => [],
  );
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

// The same walk for the sync handler's ignored-paths read, so a
// dialog listing a worktree and its picker browsing it share one.
export const cachedIgnoredPaths = (worktreePath: string) =>
  ignoredPathsCache.get(worktreePath);

// An entry of `relative` as a root-relative path.
function pathOf(relative: string, name: string): string {
  return relative ? `${relative}/${name}` : name;
}

// One checkout's entries in `relative`, with git's ignore verdict per
// root-relative path: the ignored walk, plus (with `ruleIgnored`) the
// folders a rule names that the walk passes over (ruleIgnoredFolders
// below). Throws when the folder can't be read.
async function readFolderVerdicts(
  checkoutPath: string,
  relative: string,
  ruleIgnored: boolean,
): Promise<{ entries: Dirent[]; isIgnored: (path: string) => boolean }> {
  const [entries, ignored] = await Promise.all([
    readdir(join(checkoutPath, relative), { withFileTypes: true }),
    ignoredPathsCache.get(checkoutPath),
  ]);
  const byWalk = makeIgnoreMatcher(ignored);
  if (!ruleIgnored) return { entries, isIgnored: byWalk };
  const byRule = await ruleIgnoredFolders(
    checkoutPath,
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== ".git")
      .map((entry) => pathOf(relative, entry.name))
      .filter((path) => !byWalk(path)),
  );
  return {
    entries,
    isIgnored: (path: string) => byWalk(path) || byRule.has(path),
  };
}

// Folders before files, then alphabetical within each group.
function foldersFirst(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean },
): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name.localeCompare(b.name);
}

// Union of `relative` across checkouts. A checkout without the folder
// (or one git can't read) contributes nothing. Only when none can list
// it does this throw. A name is offered as ignored only when every
// checkout holding it ignores it: a file tracked in one checkout would
// collide with git's own copy at creation, and a pull from a checkout
// tracking it always copies it. `ruleIgnored` adds the verdict of
// ruleIgnoredFolders below, for the leave-out picker: carry-over must
// not take it, since such a folder holds a file git tracks.
export async function listCarryOverCandidates(
  projectId: string,
  projectPath: string,
  relative: string,
  { ruleIgnored = false }: { ruleIgnored?: boolean } = {},
): Promise<CarryOverCandidate[]> {
  const checkouts = await listCarryOverCheckouts(projectId, projectPath);
  const listed = await Promise.all(
    checkouts.map(async (checkout) => {
      try {
        const { entries, isIgnored } = await readFolderVerdicts(
          checkout.path,
          relative,
          ruleIgnored,
        );
        return { checkout, entries, isIgnored };
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
      const path = pathOf(relative, entry.name);
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
  return [...byName.values()].toSorted(foldersFirst);
}

// The folders among `folders` (root-relative) that a rule names even
// though git's ignored walk passes over them: the walk lists untracked
// paths only, so a folder holding one force-added file never collapses
// to a single ignored entry. The mirror engine reads the rules alone
// and stays out of such a folder whole, so the picker has to call it
// ignored too, or it would offer a file inside that can never cross.
// `--no-index` asks the rules without the index's say. Exit 1 (none
// match) reads as none, and an oddly named folder git quotes drops out
// the same way.
async function ruleIgnoredFolders(
  worktreePath: string,
  folders: readonly string[],
): Promise<Set<string>> {
  const found = await Promise.all(
    chunked(folders).map((chunk) =>
      runLenient(worktreePath, [
        "-c",
        "core.quotePath=false",
        "check-ignore",
        "--no-index",
        "--",
        // The slash tells a directory-only rule (build/) what it is.
        ...chunk.map((folder) => `${folder}/`),
      ]),
    ),
  );
  return new Set(
    found.flatMap((out) =>
      out.split("\n").filter(Boolean).map(normalizeRelPath),
    ),
  );
}

// One folder of one checkout, with git's ignore verdict per entry: the
// mirror dialog's picker of what stays behind (shared/ipc/modules/
// sync.ts worktreeFolder). Folders first, then alphabetical, like the
// carry-over listing, and .git left out for the same reason.
export async function listWorktreeFolder(
  worktreePath: string,
  relative: string,
): Promise<SyncWorktreeFolderEntry[]> {
  const { entries, isIgnored } = await readFolderVerdicts(
    worktreePath,
    relative,
    true,
  );
  // A link to a folder is a folder to browse: pnpm's node_modules is
  // nothing else. A dangling link stays a (dead) file. The rule
  // verdicts above are asked of real folders only: git refuses a
  // pathspec at or past a symlink, and a link's own verdict is in the
  // ignored walk already, which names it like a file.
  const listed = await Promise.all(
    entries
      .filter((entry) => entry.name !== ".git")
      .map(async (entry) => ({
        name: entry.name,
        isDirectory:
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await stat(join(worktreePath, pathOf(relative, entry.name))).then(
              (target) => target.isDirectory(),
              () => false,
            ))),
      })),
  );
  return listed
    .map(({ name, isDirectory }) => ({
      name,
      isDirectory,
      ignored: isIgnored(pathOf(relative, name)),
    }))
    .toSorted(foldersFirst);
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
