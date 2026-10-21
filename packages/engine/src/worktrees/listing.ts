// Worktrees' listing: which checkouts a project has (their identities),
// the marks on them, and what each one's row says (its sync, changes,
// commits and marks), the base every other area builds on.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../Config.ts";
import * as Git from "../Git.ts";
import {
  shortRefName,
  splitRemoteRef,
  type WorktreeEntry,
} from "../gitParse.ts";
import * as Layout from "../Layout.ts";
import { isAbsent } from "../platformErrors.ts";
import * as Registry from "../Registry.ts";
import type { RegisteredProject } from "../Registry.ts";
import {
  idleShelfAfter,
  idleShelfCandidate,
  idleShelfTakes,
  lastTouchedAt,
  type ShelfObservation,
  type ShelfSnapshot,
  shelfWorked,
  snapshotOf,
} from "../shelf.ts";
import * as WorktreeData from "../WorktreeData.ts";
import { isManagedPath, worktreeIdFromPath } from "../worktreeLayout.ts";
import {
  type IdentityRow,
  type Located,
  RECENT_COMMITS,
  ROW_SLOTS,
  type WorktreeIdentity,
  type WorktreeRow,
  across,
  deriveBranch,
  externalWorktreeName,
  hasWorktreeData,
  isAgentWorking,
  isShelved,
  nonEmpty,
  primaryCheckoutPath,
  primaryFirst,
  sessionsOf,
} from "./documents.ts";

const identityRowOf = (
  worktree: WorktreeIdentity,
  marked: {
    readonly shelved: ReadonlySet<string>;
    readonly autoPull: ReadonlySet<string>;
    readonly agentSessions: Registry.BoundSessions;
  },
  refs: Pick<IdentityRow, "primaryRef" | "primaryBranch">,
): IdentityRow =>
  Object.assign(
    {
      id: worktree.id,
      projectId: worktree.projectId,
      name: worktree.name,
      branch: worktree.branch,
      path: worktree.path,
      isPrimary: worktree.isPrimary,
      isExternal: worktree.isExternal,
      detached: worktree.detached,
      shelved: isShelved(worktree, marked.shelved),
      autoPull: marked.autoPull.has(worktree.id),
      agentWorking: isAgentWorking(worktree, marked),
    },
    refs,
  );

export const makeListing = Effect.gen(function* () {
  const git = yield* Git.Git;
  const config = yield* Config.Config;
  const layout = yield* Layout.Layout;
  const registry = yield* Registry.Registry;
  const data = yield* WorktreeData.WorktreeData;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const deviceFlag = config.device;

  // The project's settings and its default branch, which count only
  // once it is configured (it has one).
  const projectSettings = (project: RegisteredProject) =>
    config
      .read({ kind: "project", projectId: project.id, path: project.path })
      .pipe(Effect.map(Config.projectSettingsOf));

  // What `git worktree list` reads, read with no git: where the common
  // dir really is, its HEAD and config, the names under `worktrees/`,
  // and each linked worktree's gitdir, HEAD and lock, with the reftable
  // stacks a repository in that format keeps HEAD in. A branch's commit
  // isn't among them, and no identity carries one (a detached one's is
  // its HEAD). Each by its content, inode and mtime: a change undone (a
  // rebase back on its branch, a checkout and back) reads the same, but
  // git renames a new HEAD, config or table list into place and
  // rewrites a gitdir in place, with a later mtime. And the names by
  // their directory's mtime too, which moves with one added and removed
  // between two reads. None when one can't be read, or the common dir
  // isn't found this way.
  const worktreeFilesOf = (projectPath: string) =>
    Effect.gen(function* () {
      const common = yield* Git.commonDirOf(projectPath);
      if (common === null) return Option.none<string>();
      const worktrees = path.join(common, "worktrees");
      const names = yield* fs
        .readDirectory(worktrees)
        .pipe(Effect.catchIf(isAbsent, () => Effect.succeed<string[]>([])));
      const named = yield* fs.stat(worktrees).pipe(
        Effect.map((info) =>
          Option.getOrNull(Option.map(info.mtime, (date) => date.getTime())),
        ),
        Effect.catchIf(isAbsent, () => Effect.succeed(null)),
      );
      const files = [
        "HEAD",
        "config",
        "reftable/tables.list",
        ...names
          .toSorted()
          .flatMap((name) =>
            ["gitdir", "HEAD", "locked", "reftable/tables.list"].map(
              (file) => `worktrees/${name}/${file}`,
            ),
          ),
      ];
      const seen = yield* Effect.forEach(
        files,
        (file) => {
          const at = path.join(common, file);
          return Effect.all([fs.stat(at), fs.readFileString(at)]).pipe(
            Effect.map(([info, text]) => [
              Option.getOrNull(info.ino),
              Option.getOrNull(
                Option.map(info.mtime, (date) => date.getTime()),
              ),
              text,
            ]),
            Effect.catchIf(isAbsent, () => Effect.succeed(null)),
          );
        },
        { concurrency: "unbounded" },
      );
      const real = yield* fs.realPath(common);
      return Option.some(JSON.stringify([real, named, files, seen]));
    }).pipe(
      Effect.provide(platform),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // git's last `worktree list` of each project and the files it was read
  // from, answered again while they say the same. Kept only when they
  // read the same before git ran and after, so the answer is theirs and
  // not that of a change made while git ran, which they could read as
  // undone later.
  const lastListed = new Map<
    string,
    { readonly files: string; readonly entries: ReadonlyArray<WorktreeEntry> }
  >();
  const listWorktrees = Effect.fn(function* (projectPath: string) {
    const files = yield* worktreeFilesOf(projectPath);
    const last = lastListed.get(projectPath);
    if (Option.isSome(files) && last?.files === files.value) {
      return last.entries;
    }
    const entries = yield* git.listWorktrees(projectPath);
    const after = yield* worktreeFilesOf(projectPath);
    if (
      Option.isSome(files) &&
      Option.isSome(after) &&
      after.value === files.value
    ) {
      lastListed.set(projectPath, { files: files.value, entries });
    } else {
      lastListed.delete(projectPath);
    }
    return entries;
  });

  const identities = Effect.fn("Worktrees.identities")(function* (
    project: RegisteredProject,
  ) {
    const entries = yield* listWorktrees(project.path);
    const bases = yield* layout.managedBases(project);
    const codexNames = yield* Effect.cached(deviceFlag("codexWorktreeNames"));
    const primaryPath = primaryCheckoutPath(entries, project.path);
    const found: WorktreeIdentity[] = [];
    for (const entry of entries) {
      if (entry.bare) continue;
      const isPrimary = entry.path === primaryPath;
      const isExternal = !isManagedPath(entry.path, bases);
      // The primary keeps its folder's name.
      const name =
        isExternal && !isPrimary && (yield* codexNames)
          ? externalWorktreeName(path, entry.path, project.path)
          : path.basename(entry.path);
      found.push({
        id: worktreeIdFromPath(entry.path),
        projectId: project.id,
        name,
        branch: deriveBranch(entry),
        path: entry.path,
        isPrimary,
        isExternal,
        detached: entry.detached,
        locked: entry.locked,
      });
    }
    return found;
  });

  // The project's primary ref, the default-branch setting honored, and
  // its remotes alongside.
  const primaryRefOf = Effect.fn(function* (project: RegisteredProject) {
    const [remotes, { settings, defaultBranch }] = yield* Effect.all(
      [git.listRemotes(project.path), projectSettings(project)],
      { concurrency: 2 },
    );
    const fullRef = Option.getOrElse(
      yield* git.resolvePrimaryRef(project.path, defaultBranch, remotes),
      () => "",
    );
    const primaryRef = shortRefName(fullRef);
    // The ref's local branch: "main" for "origin/main", and for a remote
    // ref whose remote is gone, its name past the first segment. So the
    // branch equals the ref exactly when the ref is a local branch.
    const primaryBranch = fullRef.startsWith("refs/remotes/")
      ? (splitRemoteRef(primaryRef, remotes)?.branch ??
        primaryRef.slice(primaryRef.indexOf("/") + 1))
      : primaryRef;
    return { remotes, primaryRef, primaryBranch, settings };
  });

  // The marks, with any worktree shelved the shelf's snapshots, and with
  // the idle shelf on the unshelve times, read before the probes: a
  // snapshot taken after a row's probes started must not be compared
  // against them, and an unshelve after them wins over the idle shelf.
  const marks = Effect.gen(function* () {
    const [shelved, autoPull, agentSessions, idleAfter] = yield* Effect.all(
      [
        registry.marked("shelved"),
        registry.marked("autoPull"),
        registry.agentSessions,
        Effect.map(config.device("autoShelveDays"), idleShelfAfter),
      ],
      { concurrency: 4 },
    );
    const snapshots = new Map<string, ShelfSnapshot>(
      shelved.size === 0
        ? []
        : (yield* sql<ShelfSnapshot & { worktree_id: string }>`
              SELECT worktree_id, at, head, changed FROM shelf_snapshots`.pipe(
            Effect.orElseSucceed(() => []),
          )).map(({ worktree_id, ...snapshot }) => [worktree_id, snapshot]),
    );
    const unshelvedAt = new Map<string, number>(
      idleAfter === 0
        ? []
        : (yield* sql<{ worktree_id: string; at: number }>`
              SELECT worktree_id, at FROM unshelved_at`.pipe(
            Effect.orElseSucceed(() => []),
          )).map(({ worktree_id, at }) => [worktree_id, at]),
    );
    return {
      shelved,
      autoPull,
      agentSessions,
      snapshots,
      idleAfter,
      unshelvedAt,
    };
  });

  // What every row of one project is built against, read once.
  const contextOf = Effect.fn(function* (
    project: RegisteredProject,
    marked: Effect.Success<typeof marks>,
  ) {
    const primary = yield* primaryRefOf(project);
    const chain = yield* Effect.cached(
      git.firstParentChain(project.path, primary.primaryRef),
    );
    return { project, ...primary, ...marked, chain };
  });
  type RowContext = Effect.Success<ReturnType<typeof contextOf>>;

  // When the linked worktree was added, epoch ms: the mtime of its admin
  // dir's commondir file, which `git worktree add` writes once. Zero for
  // the primary checkout, whose .git is a directory.
  const createdAtOf = (worktreePath: string) =>
    Effect.gen(function* () {
      const admin = yield* git.adminDirOf(worktreePath);
      if (Option.isNone(admin)) return 0;
      const info = yield* fs.stat(path.join(admin.value, "commondir"));
      return Math.max(
        Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        }),
        0,
      );
    }).pipe(Effect.orElseSucceed(() => 0));

  const descriptionOf = (worktree: WorktreeIdentity) =>
    hasWorktreeData(worktree)
      ? data.description(worktree.projectId, worktree.id)
      : Effect.succeed(WorktreeData.NO_DESCRIPTION);

  // A row, and what the shelf needs of its probes: when they started,
  // and whether the status answered (a failed one shows as 0 changes,
  // which the shelf must not compare).
  const probe = (worktree: WorktreeIdentity, context: RowContext) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const relation =
        context.primaryRef === "" || worktree.isPrimary || worktree.detached
          ? Effect.succeed({ behindPrimary: 0, mergedIntoPrimary: false })
          : git.primaryRelation({
              worktree: worktree.path,
              primaryRef: context.primaryRef,
              chain: context.chain,
            });
      const probes = yield* Effect.all(
        {
          changes: Effect.result(git.workingTreeChanges(worktree.path)),
          commits: git.listCommits(worktree.path, {
            skip: 0,
            count: RECENT_COMMITS,
          }),
          sync: git.upstreamSync(worktree.path),
          relation,
          unpushed: git.unpushedCount(worktree.path),
          createdAt: createdAtOf(worktree.path),
          described: descriptionOf(worktree),
        },
        { concurrency: "unbounded" },
      );
      const changes = Result.getOrElse(probes.changes, () => ({
        count: 0,
        lastChangeAt: 0,
      }));
      const { title, description } = probes.described;
      const row: WorktreeRow = {
        id: worktree.id,
        projectId: worktree.projectId,
        name: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        ahead: probes.sync.ahead,
        behind: probes.sync.behind,
        hasUpstream: probes.sync.hasUpstream,
        hasRemote: context.remotes.length > 0,
        divergedClean: probes.sync.divergedClean,
        behindPrimary: probes.relation.behindPrimary,
        unpushedCount: probes.unpushed,
        ...nonEmpty("primaryRef", context.primaryRef),
        ...nonEmpty("primaryBranch", context.primaryBranch),
        mergedIntoPrimary: probes.relation.mergedIntoPrimary,
        changedCount: changes.count,
        ...nonEmpty("lastChangeAt", changes.lastChangeAt),
        ...nonEmpty("createdAt", probes.createdAt),
        recentCommits: probes.commits,
        isPrimary: worktree.isPrimary,
        isExternal: worktree.isExternal,
        detached: worktree.detached,
        shelved: isShelved(worktree, context.shelved),
        // Unlike the shelf, any checkout can follow its upstream.
        autoPull: context.autoPull.has(worktree.id),
        agentWorking: isAgentWorking(worktree, context),
        agentSessions: sessionsOf(worktree, context),
        ...nonEmpty("title", title),
        ...nonEmpty("description", description),
        projectName: context.project.name,
      };
      return { row, at, statusOk: Result.isSuccess(probes.changes) };
    });
  type Probed = Effect.Success<ReturnType<typeof probe>>;

  // When HEAD last moved in a linked worktree, epoch ms: the mtime of
  // its admin dir's HEAD reflog, which every commit, checkout, rebase and
  // reset appends to. 0 when there is none to read.
  const headMovedAt = (worktreePath: string) =>
    Effect.gen(function* () {
      const admin = yield* git.adminDirOf(worktreePath);
      if (Option.isNone(admin)) return 0;
      const info = yield* fs.stat(path.join(admin.value, "logs", "HEAD"));
      return Math.max(
        Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        }),
        0,
      );
    }).pipe(Effect.orElseSucceed(() => 0));

  // Settles every row of one listing against the shelf its marks read,
  // in one transaction: a shelved row without a snapshot gets one, a
  // shelved row worked in since comes back unshelved, and a row the idle
  // shelf takes goes on the shelf with its snapshot. A row whose status
  // failed is left alone. The listing read the marks before its probes
  // and acts after them, so each write checks again: a shelve or
  // unshelve in between (which drops the snapshot) wins over the
  // listing's stale view. An idle shelve lands only while the worktree
  // is still unmarked and hasn't been unshelved since the listing read
  // the unshelve times, a seed only while the worktree is still marked
  // and has none, and a retire only while the snapshot is the one
  // compared against. A retire counts as an unshelve.
  const settle = (
    probed: ReadonlyArray<Probed>,
    marked: Pick<
      Effect.Success<typeof marks>,
      "snapshots" | "idleAfter" | "unshelvedAt"
    >,
  ) => {
    const rows = probed.map(({ row }) => row);
    return Effect.gen(function* () {
      const seeds: Array<[string, ShelfSnapshot]> = [];
      const retires: Array<[string, number]> = [];
      const shelves: Array<[string, ShelfSnapshot]> = [];
      for (const { row, at, statusOk } of probed) {
        if (!statusOk) continue;
        const seen: ShelfObservation = {
          at,
          head: row.recentCommits[0]?.hash ?? "",
          changed: row.changedCount,
          lastChangeAt: row.lastChangeAt ?? 0,
          followsUpstream: row.autoPull && row.unpushedCount === 0,
        };
        if (!row.shelved) {
          if (marked.idleAfter === 0 || !idleShelfCandidate(row)) continue;
          const touched = lastTouchedAt(
            row,
            yield* headMovedAt(row.path),
            marked.unshelvedAt.get(row.id) ?? 0,
          );
          if (idleShelfTakes(touched, at, marked.idleAfter)) {
            shelves.push([row.id, snapshotOf(seen)]);
          }
          continue;
        }
        const snapshot = marked.snapshots.get(row.id);
        if (snapshot === undefined) seeds.push([row.id, snapshotOf(seen)]);
        else if (shelfWorked(snapshot, seen))
          retires.push([row.id, snapshot.at]);
      }
      if (seeds.length === 0 && retires.length === 0 && shelves.length === 0)
        return rows;
      const flipped = new Map<string, boolean>();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const [id, { at, head, changed }] of shelves) {
            const read = marked.unshelvedAt.get(id) ?? null;
            const shelved =
              yield* sql`INSERT INTO worktree_marks (worktree_id, mark)
                SELECT ${id}, 'shelved'
                WHERE (SELECT at FROM unshelved_at WHERE worktree_id = ${id}) IS ${read}
                ON CONFLICT DO NOTHING RETURNING worktree_id`;
            if (shelved.length === 0) continue;
            yield* sql`DELETE FROM unshelved_at WHERE worktree_id = ${id}`;
            yield* sql`INSERT INTO shelf_snapshots (worktree_id, at, head, changed)
                VALUES (${id}, ${at}, ${head}, ${changed})
                ON CONFLICT (worktree_id) DO UPDATE SET at = excluded.at,
                  head = excluded.head, changed = excluded.changed`;
            flipped.set(id, true);
          }
          for (const [id, { at, head, changed }] of seeds) {
            yield* sql`INSERT INTO shelf_snapshots (worktree_id, at, head, changed)
                SELECT ${id}, ${at}, ${head}, ${changed}
                WHERE EXISTS (SELECT 1 FROM worktree_marks
                  WHERE worktree_id = ${id} AND mark = 'shelved')
                ON CONFLICT (worktree_id) DO NOTHING`;
          }
          const now = yield* Clock.currentTimeMillis;
          for (const [id, at] of retires) {
            const retired = yield* sql`DELETE FROM shelf_snapshots
                WHERE worktree_id = ${id} AND at = ${at} RETURNING worktree_id`;
            if (retired.length === 0) continue;
            yield* sql`DELETE FROM worktree_marks
                WHERE worktree_id = ${id} AND mark = 'shelved'`;
            yield* sql`INSERT INTO unshelved_at (worktree_id, at)
                VALUES (${id}, ${now})
                ON CONFLICT (worktree_id) DO UPDATE SET at = excluded.at`;
            flipped.set(id, false);
          }
        }),
      );
      return rows.map((row) => {
        const shelved = flipped.get(row.id);
        return shelved === undefined
          ? row
          : Object.assign({}, row, { shelved });
      });
    }).pipe(
      // A failed write changes no row: the next listing tries again.
      Effect.catchTags({ SqlError: () => Effect.succeed(rows) }),
    );
  };

  const rowsOf = Effect.fn("Worktrees.rowsOf")(function* (
    project: RegisteredProject,
    marked: Effect.Success<typeof marks>,
  ) {
    const [found, context] = yield* Effect.all(
      [identities(project), contextOf(project, marked)],
      { concurrency: 2 },
    );
    const probed = yield* Effect.forEach(
      primaryFirst(found),
      (worktree) => probe(worktree, context),
      { concurrency: ROW_SLOTS },
    );
    return yield* settle(probed, context);
  });

  const list = Effect.fn("Worktrees.list")(function* (
    projects: ReadonlyArray<RegisteredProject>,
  ) {
    const marked = yield* marks;
    return yield* across(projects, (project) => rowsOf(project, marked));
  });

  const row = Effect.fn("Worktrees.row")(function* (
    located: Located,
    options: { readonly settle?: boolean } = {},
  ) {
    const context = yield* contextOf(located.project, yield* marks);
    const probed = yield* probe(located.worktree, context);
    if (!options.settle) return probed.row;
    const [settled] = yield* settle([probed], context);
    return settled ?? probed.row;
  });

  // The project's primary ref as the identity rows carry it, asked for
  // or not.
  const refsOf = (project: RegisteredProject, withPrimaryRef: boolean) =>
    withPrimaryRef
      ? primaryRefOf(project).pipe(
          Effect.map(({ primaryRef, primaryBranch }) => ({
            ...nonEmpty("primaryRef", primaryRef),
            ...nonEmpty("primaryBranch", primaryBranch),
          })),
        )
      : Effect.succeed({});

  const identityList = Effect.fn("Worktrees.identityList")(function* (
    projects: ReadonlyArray<RegisteredProject>,
    options: { readonly primaryRef: boolean },
  ) {
    const marked = yield* marks;
    return yield* across(projects, (project) =>
      Effect.all([identities(project), refsOf(project, options.primaryRef)], {
        concurrency: 2,
      }).pipe(
        Effect.map(([found, refs]) =>
          primaryFirst(found).map((worktree) =>
            identityRowOf(worktree, marked, refs),
          ),
        ),
      ),
    );
  });

  const identityRow = Effect.fn("Worktrees.identityRow")(function* (
    located: Located,
    options: { readonly primaryRef: boolean },
  ) {
    return identityRowOf(
      located.worktree,
      yield* marks,
      yield* refsOf(located.project, options.primaryRef),
    );
  });

  return {
    deviceFlag,
    projectSettings,
    identities,
    primaryRefOf,
    marks,
    descriptionOf,
    list,
    row,
    identityList,
    identityRow,
  };
});

export type ListingArea = Effect.Success<typeof makeListing>;
