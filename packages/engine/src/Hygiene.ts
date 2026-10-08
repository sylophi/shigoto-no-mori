// What the tidy page shows of a project's worktrees: how stale each is,
// whether its work already landed in the primary branch, and how much
// disk it holds. The facts are all git and fast enough to wait for. Disk
// usage walks the whole folder (node_modules and all) through the darwin
// helper and is asked per row, so a slow disk never holds the page up.
import { isRealBranch } from "@shigomori/contracts/schemas/project";
import type {
  WorktreeDiskUsage,
  WorktreeHygiene,
} from "@shigomori/contracts/schemas/hygiene";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Darwin from "./Darwin.ts";
import * as Git from "./Git.ts";
import { splitRemoteRef } from "./gitParse.ts";
import type { RegisteredProject } from "./Registry.ts";
import * as Worktrees from "./Worktrees.ts";

// A folder's measure: `bytes` is its footprint, what `du` reports
// (allocated blocks, each inode once). `reclaimableBytes` is what
// removing it would free, usually far less: pnpm imports packages as
// clones of its store (or hard links), and carry-over clones from the
// primary, so most of a node_modules shares its blocks with copies
// outside the worktree. A hard-linked inode counts only when every link
// is inside, and each inode only its private blocks.
export type DiskUsage = {
  readonly bytes: number;
  readonly reclaimableBytes: number;
  // The newest mtime (epoch ms) outside the folders that change without
  // anyone working (ACTIVITY_EXCLUDED), null when nothing was datable.
  readonly lastActivityAt: number | null;
  // An entry couldn't be read, so the totals are floors.
  readonly partial: boolean;
};

export class Hygiene extends Context.Service<
  Hygiene,
  {
    // Each worktree's facts, from git alone.
    readonly facts: (
      project: RegisteredProject,
    ) => Effect.Effect<ReadonlyArray<WorktreeHygiene>, Git.GitError>;
    // A worktree's disk usage, its nested worktrees left to their own
    // rows. Kept for a minute, since a walk of a big checkout costs real
    // IO and the page asks again on focus.
    readonly diskUsage: (
      project: RegisteredProject,
      worktreeId: string,
    ) => Effect.Effect<
      WorktreeDiskUsage,
      Worktrees.UnknownWorktree | Git.GitError
    >;
    // A folder measured, `exclude` (absolute paths) stepped over whole.
    // Never fails: what can't be read makes the result partial.
    readonly measure: (
      root: string,
      exclude: ReadonlyArray<string>,
    ) => Effect.Effect<DiskUsage>;
  }
>()("sm/engine/Hygiene") {}

// Names whose contents are disk usage but not evidence anyone touched the
// worktree: a fresh `pnpm install` rewrites every mtime under
// node_modules. Matched against files too, which matters for ".git": in
// a linked worktree that is a pointer file stamped at creation.
const ACTIVITY_EXCLUDED = new Set([
  ".git",
  ".shigomori",
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "__pycache__",
]);

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// A ref to compare against, and the tree it points at. A null tree means
// it wouldn't resolve, which turns the containment probe off for it.
type PrimaryCandidate = { readonly ref: string; readonly tree: string | null };

// Probes run through a shared window: this is asked for every project at
// once, and each worktree's chain can include a merge-tree.
const PROBE_SLOTS = 6;
// Each walk is a helper streaming a whole tree, so a wider window mostly
// makes the first size land later.
const WALK_SLOTS = 3;

// Whether `path` is `root` or inside it.
const isSameOrInside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const darwin = yield* Darwin.Darwin;
  const worktrees = yield* Worktrees.Worktrees;
  const probes = yield* Semaphore.make(PROBE_SLOTS);
  const walks = yield* Semaphore.make(WALK_SLOTS);

  // --- the facts ---

  // The commit HEAD points at: epoch ms and abbreviated hash, both null
  // for an empty repo.
  const headCommit = (worktree: string) =>
    git.run(worktree, ["log", "-1", "--format=%ct%n%h"]).pipe(
      Effect.map((stdout) => {
        const [seconds, hash] = stdout.trim().split("\n");
        const at = Number(seconds);
        return {
          at: Number.isFinite(at) ? Math.floor(at * 1000) : null,
          hash: hash?.trim() || null,
        };
      }),
      Effect.orElseSucceed(() => ({ at: null, hash: null })),
    );

  // Commits on HEAD that `ref` doesn't have, null when they can't be
  // counted. The null matters: 0 is what makes the page tick a row, and
  // a prunable worktree or a corrupt repo fails here.
  const uniqueCommits = (worktree: string, ref: string) =>
    git.run(worktree, ["rev-list", "--count", `${ref}..HEAD`]).pipe(
      Effect.map((stdout) => {
        const count = Number(stdout.trim());
        return Number.isInteger(count) && count >= 0 ? count : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  // Untracked files whatever status.showUntrackedFiles says, asked only
  // for a row the page would otherwise tick. Unreadable cuts the same
  // way as dirty.
  const hasUntracked = (worktree: string) =>
    git
      .run(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
      .pipe(
        Effect.map((stdout) => stdout.length > 0),
        Effect.orElseSucceed(() => true),
      );

  // Whether merging the branch into the candidate changes nothing: the
  // state a squash- or rebase-merged branch is left in, which counting
  // commits can't see. Every failure reads as still carrying work.
  const contentAlreadyIn = (
    repo: string,
    candidate: PrimaryCandidate,
    head: string,
  ) =>
    candidate.tree === null
      ? Effect.succeed(false)
      : git
          .run(repo, ["merge-tree", "--write-tree", candidate.ref, head], {
            okExitCodes: [1],
          })
          .pipe(
            Effect.map(
              (merged) => merged.split("\n", 1)[0]?.trim() === candidate.tree,
            ),
            Effect.orElseSucceed(() => false),
          );

  // Every ref that counts as the primary branch for containment: the
  // remote one, and its local branch, since work merged locally isn't
  // lost either. Canonical first, so the reported ref is the remote one
  // whenever it holds the work.
  const candidatesOf = (
    repo: string,
    primaryRef: string | null,
    remotes: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      if (primaryRef === null) return [];
      const split = splitRemoteRef(primaryRef, remotes);
      const refs = [primaryRef];
      if (
        split !== undefined &&
        split.branch !== primaryRef &&
        (yield* git.localBranchExists(repo, split.branch))
      ) {
        refs.push(split.branch);
      }
      return yield* Effect.forEach(refs, (ref) =>
        git.treeOf(repo, ref).pipe(
          Effect.map((tree): PrimaryCandidate => ({ ref, tree })),
          Effect.orElseSucceed((): PrimaryCandidate => ({ ref, tree: null })),
        ),
      );
    });

  const factsOf = (
    identity: Worktrees.IdentityRow,
    repo: string,
    candidates: ReadonlyArray<PrimaryCandidate>,
    primaryBranch: string | null,
  ) =>
    Effect.gen(function* () {
      const head = yield* headCommit(identity.path);
      const base: WorktreeHygiene = {
        worktreeId: identity.id,
        lastCommitAt: head.at,
        headHash: head.hash,
        uniqueCommits: null,
        contentAlreadyInPrimary: false,
        primaryRef: candidates[0]?.ref ?? null,
        holdsPrimaryBranch:
          !identity.detached &&
          primaryBranch !== null &&
          identity.branch === primaryBranch,
        untracked: false,
      };
      // Nothing to compare for the primary, a detached HEAD, or without a
      // primary ref: the page reads those as "can't tell", never ticked.
      if (
        candidates.length === 0 ||
        identity.isPrimary ||
        identity.detached ||
        !isRealBranch(identity.branch)
      ) {
        return base;
      }
      // The first candidate that contains the work wins, and the facts
      // name it. Contained rows are checked for untracked files last.
      let fallback: WorktreeHygiene | null = null;
      for (const candidate of candidates) {
        const unique = yield* uniqueCommits(identity.path, candidate.ref);
        if (unique === null) continue;
        if (
          unique === 0 ||
          (yield* contentAlreadyIn(repo, candidate, identity.branch))
        ) {
          return {
            ...base,
            primaryRef: candidate.ref,
            uniqueCommits: unique,
            contentAlreadyInPrimary: true,
            untracked: yield* hasUntracked(identity.path),
          };
        }
        fallback ??= {
          ...base,
          primaryRef: candidate.ref,
          uniqueCommits: unique,
        };
      }
      return fallback ?? base;
    });

  // A project's identities with its primary ref, kept long enough to
  // serve one page load: the page asks for every row's size at once.
  // Keyed by the project as text: a key compares by value.
  const identities = yield* Cache.make({
    lookup: (key: string) =>
      worktrees
        .identityList([JSON.parse(key) as RegisteredProject], {
          primaryRef: true,
        })
        .pipe(
          Effect.flatMap(({ rows, skipped }) =>
            skipped[0] === undefined
              ? Effect.succeed(rows)
              : Effect.fail(skipped[0].error),
          ),
        ),
    capacity: 64,
    timeToLive: Duration.seconds(10),
  });

  const identitiesOf = (project: RegisteredProject) =>
    Cache.get(
      identities,
      JSON.stringify({
        id: project.id,
        name: project.name,
        path: project.path,
      }),
    );

  const facts = Effect.fn("Hygiene.facts")(function* (
    project: RegisteredProject,
  ) {
    const [listed, remotes] = yield* Effect.all(
      [identitiesOf(project), git.listRemotes(project.path)],
      { concurrency: 2 },
    );
    // Resolved once per project and carried on every identity.
    const primaryRef = listed[0]?.primaryRef ?? null;
    const primaryBranch = listed[0]?.primaryBranch ?? null;
    const candidates = yield* candidatesOf(project.path, primaryRef, remotes);
    return yield* Effect.forEach(
      listed,
      (identity) =>
        probes.withPermit(
          factsOf(identity, project.path, candidates, primaryBranch),
        ),
      { concurrency: "unbounded" },
    );
  });

  // --- disk usage ---

  const measure = Effect.fn("Hygiene.measure")(function* (
    root: string,
    exclude: ReadonlyArray<string>,
  ) {
    const relativeExcludes = exclude
      .filter((path) => path !== root && isSameOrInside(path, root))
      .map((path) => path.slice(root.length + 1));
    const excluded = (rel: string) =>
      relativeExcludes.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
    // Whether a path's own name and every folder above it may date
    // activity.
    const countsAsActivity = (rel: string) =>
      rel === "." ||
      rel.split("/").every((part) => !ACTIVITY_EXCLUDED.has(part));

    let bytes = 0;
    let reclaimable = 0;
    let lastActivityAt: number | null = null;
    let partial = false;
    // Single-linked files whose private size is asked once the walk ends.
    const own: Array<{ rel: string; allocated: number }> = [];
    // Multiply linked inodes: counted once, and toward reclaimable only
    // when the walk met every link.
    const linked = new Map<
      string,
      { rel: string; nlink: number; seen: number; allocated: number }
    >();

    yield* darwin.lstat({ root }).pipe(
      Stream.runForEach((entry) =>
        Effect.sync(() => {
          if (Darwin.isFailed(entry)) {
            partial = true;
            return;
          }
          if (entry.path !== "." && excluded(entry.path)) return;
          const kind = entry.mode & S_IFMT;
          const allocated = entry.blocks * 512;
          if (kind === S_IFDIR) {
            // A folder's own blocks: 0 on APFS, a block or more on ext4.
            bytes += allocated;
            reclaimable += allocated;
            return;
          }
          // Symlinks count as themselves, never their target, and never
          // as activity. Anything else (a fifo, a socket) is skipped.
          if (kind !== S_IFREG && kind !== S_IFLNK) return;
          if (kind === S_IFREG && countsAsActivity(entry.path)) {
            const mtime =
              entry.mtimeSec * 1000 + Math.floor(entry.mtimeNsec / 1e6);
            if (lastActivityAt === null || mtime > lastActivityAt) {
              lastActivityAt = mtime;
            }
          }
          if (entry.nlink > 1) {
            const key = `${entry.dev}:${entry.ino}`;
            const inode = linked.get(key) ?? {
              rel: entry.path,
              nlink: entry.nlink,
              seen: 0,
              allocated,
            };
            inode.seen++;
            linked.set(key, inode);
            return;
          }
          bytes += allocated;
          if (allocated > 0) own.push({ rel: entry.path, allocated });
        }),
      ),
      // The helper failing outright is a measure that couldn't finish.
      Effect.catch(() => Effect.sync(() => void (partial = true))),
    );

    for (const inode of linked.values()) {
      bytes += inode.allocated;
      if (inode.seen >= inode.nlink) own.push(inode);
    }
    // What deleting each file would free: its private blocks where the
    // volume can tell (APFS), else all of them.
    const privateSizes = yield* own.length === 0
      ? Effect.succeed(new Map<string, number | null>())
      : darwin.privateSize({ root, paths: own.map(({ rel }) => rel) }).pipe(
          Stream.runCollect,
          Effect.map(
            (entries) =>
              new Map(
                entries.flatMap((entry) =>
                  Darwin.isFailed(entry) ? [] : [[entry.path, entry.bytes]],
                ),
              ),
          ),
          Effect.orElseSucceed(() => new Map<string, number | null>()),
        );
    for (const { rel, allocated } of own) {
      const privateBytes = privateSizes.get(rel);
      reclaimable +=
        privateBytes === undefined || privateBytes === null
          ? allocated
          : Math.min(privateBytes, allocated);
    }
    return { bytes, reclaimableBytes: reclaimable, lastActivityAt, partial };
  });

  // Keyed by the path and what was carved out of it, so a walk isn't
  // reused after a nested worktree came or went.
  const measured = yield* Cache.make({
    lookup: (key: string) => {
      const [root = key, ...excluded] = key.split("\0");
      return walks.withPermit(measure(root, excluded));
    },
    capacity: 256,
    timeToLive: Duration.minutes(1),
  });

  const diskUsage = Effect.fn("Hygiene.diskUsage")(function* (
    project: RegisteredProject,
    worktreeId: string,
  ) {
    const listed = yield* identitiesOf(project);
    const worktree = listed.find((identity) => identity.id === worktreeId);
    if (worktree === undefined) {
      return yield* new Worktrees.UnknownWorktree({ worktreeId });
    }
    // Under the in-project layout a project's worktrees live inside its
    // primary. Each is measured as its own row, so the enclosing walk
    // steps over them.
    const nested = listed
      .map((identity) => identity.path)
      .filter(
        (path) => path !== worktree.path && isSameOrInside(path, worktree.path),
      )
      .toSorted();
    const usage = yield* Cache.get(
      measured,
      [worktree.path, ...nested].join("\0"),
    );
    return { worktreeId, ...usage };
  });

  return Hygiene.of({ facts, diskUsage, measure });
});

export const layer = Layer.effect(Hygiene, make);
