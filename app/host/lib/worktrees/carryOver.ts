// Configure-view reads spanning every checkout of the project, for
// carry-over and for the leave-out preset's picker, which unions this
// listing across devices (renderer/hooks/remote/useRepoListing.ts).
// Entries are root-relative, so the primary and each worktree
// are all candidates. The engine applies the same idea at creation
// (CarryOver.ts looks in the base ref's
// worktree, then the primary, then the rest). Checkouts are listed
// primary first: when checkouts disagree on whether a name is a file
// or a folder, the first one holding it decides.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  makeIgnoreMatcher,
  normalizeRelPath,
} from "@shigomori/contracts/git/gitPaths";
import type {
  CarryOverCandidate,
  CarryOverStat,
} from "@shigomori/contracts/schemas";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import { listIgnoredPaths } from "../git/branches";
import { chunked, runLenient } from "../git/core";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ops from "../engineOps";
import type { WorktreeIdentity } from "../git/worktrees";
import { ttlEffectCache } from "../util/ttlCache";

export type CarryOverCheckout = Pick<
  WorktreeIdentity,
  "name" | "path" | "isPrimary"
>;

// Falls back to the primary alone when the worktree list can't be read.
// A bare repo flags no identity as primary, so the first checkout stands
// in.
export const listCarryOverCheckouts = (
  projectId: string,
  projectPath: string,
) =>
  Ops.listWorktreeIdentities({ projectId }).pipe(
    Effect.orElseSucceed((): readonly WorktreeIdentity[] => []),
    Effect.map((identities) => primaryFirst(identities, projectPath)),
  );

function primaryFirst(
  identities: readonly WorktreeIdentity[],
  projectPath: string,
): CarryOverCheckout[] {
  const checkouts = identities.toSorted(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name),
  );
  const [first, ...rest] = checkouts;
  if (first === undefined) {
    return [{ name: "primary", path: projectPath, isPrimary: true }];
  }
  if (first.isPrimary) return checkouts;
  return [{ ...first, isPrimary: true }, ...rest];
}

// The picker re-lists on every folder step while the ignored set of a
// checkout barely changes. One walk per checkout every few seconds is
// plenty.
const ignoredPathsCache = ttlEffectCache(10_000, listIgnoredPaths);

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
class FolderReadError extends Schema.TaggedError<FolderReadError>()(
  "FolderReadError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const readFolderVerdicts = Effect.fnUntraced(function* (
  checkoutPath: string,
  relative: string,
  ruleIgnored: boolean,
) {
  const [entries, ignored] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () =>
          readdir(join(checkoutPath, relative), { withFileTypes: true }),
        catch: (error) =>
          new FolderReadError({ reason: errorMessageOf(error) }),
      }),
      ignoredPathsCache.get(checkoutPath),
    ],
    { concurrency: 2 },
  );
  const byWalk = makeIgnoreMatcher(ignored);
  if (!ruleIgnored) return { entries, isIgnored: byWalk };
  const byRule = yield* ruleIgnoredFolders(
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
});

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
export const listCarryOverCandidates = Effect.fnUntraced(function* (
  checkouts: readonly CarryOverCheckout[],
  relative: string,
  { ruleIgnored = false }: { ruleIgnored?: boolean } = {},
) {
  const listed = yield* Effect.forEach(
    checkouts,
    (checkout) =>
      readFolderVerdicts(checkout.path, relative, ruleIgnored).pipe(
        Effect.map(({ entries, isIgnored }) => ({
          checkout,
          entries,
          isIgnored,
        })),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: "unbounded" },
  );
  if (listed.every((r) => r === null)) {
    return yield* new FolderReadError({
      reason: `Couldn't read ${relative || "the project root"}`,
    });
  }
  // Built up checkout by checkout, so mutable until it is returned.
  const byName = new Map<
    string,
    {
      name: string;
      isDirectory: boolean;
      ignored: boolean;
      inPrimary: boolean;
      worktrees: string[];
    }
  >();
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
  return [...byName.values()].toSorted(foldersFirst) as CarryOverCandidate[];
});

// The folders among `folders` (root-relative) that a rule names even
// though git's ignored walk passes over them: the walk lists untracked
// paths only, so a folder holding one force-added file never collapses
// to a single ignored entry. The mirror engine reads the rules alone
// and stays out of such a folder whole, so the picker has to call it
// ignored too, or it would offer a file inside that can never cross.
// `--no-index` asks the rules without the index's say. Exit 1 (none
// match) reads as none, and an oddly named folder git quotes drops out
// the same way.
const ruleIgnoredFolders = (worktreePath: string, folders: readonly string[]) =>
  Effect.map(
    Effect.forEach(
      chunked(folders),
      (chunk) =>
        runLenient(worktreePath, [
          "-c",
          "core.quotePath=false",
          "check-ignore",
          "--no-index",
          "--",
          // The slash tells a directory-only rule (build/) what it is.
          ...chunk.map((folder) => `${folder}/`),
        ]),
      { concurrency: "unbounded" },
    ),
    (found) =>
      new Set(
        found.flatMap((out) =>
          out.split("\n").filter(Boolean).map(normalizeRelPath),
        ),
      ),
  );

// One folder of one checkout, with git's ignore verdict per entry: the
// mirror dialog's picker of what stays behind and the files page's tree
// (packages/contracts/src/modules/sync.ts worktreeFolder). Folders
// first, then alphabetical, like the carry-over listing, and .git left
// out for the same reason.
export const listWorktreeFolder = Effect.fnUntraced(function* (
  worktreePath: string,
  relative: string,
  ruleIgnored: boolean,
) {
  const { entries, isIgnored } = yield* readFolderVerdicts(
    worktreePath,
    relative,
    ruleIgnored,
  );
  // A link to a folder is a folder to browse: pnpm's node_modules is
  // nothing else. A dangling link stays a (dead) file. The rule
  // verdicts above are asked of real folders only: git refuses a
  // pathspec at or past a symlink, and a link's own verdict is in the
  // ignored walk already, which names it like a file.
  const listed = yield* Effect.promise(() =>
    Promise.all(
      entries
        .filter((entry) => entry.name !== ".git")
        .map(async (entry) => ({
          name: entry.name,
          isDirectory:
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
              (await stat(
                join(worktreePath, pathOf(relative, entry.name)),
              ).then(
                (target) => target.isDirectory(),
                () => false,
              ))),
        })),
    ),
  );
  return listed
    .map(
      ({ name, isDirectory }): SyncWorktreeFolderEntry => ({
        name,
        isDirectory,
        ignored: isIgnored(pathOf(relative, name)),
      }),
    )
    .toSorted(foldersFirst);
});

// Where each configured path currently exists.
export const statCarryOverPaths = (
  checkouts: readonly CarryOverCheckout[],
  paths: readonly string[],
) => Effect.promise(() => statPaths(checkouts, paths));

async function statPaths(
  checkouts: readonly CarryOverCheckout[],
  paths: readonly string[],
): Promise<Record<string, CarryOverStat>> {
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
