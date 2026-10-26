// The host's view of the registered projects. The engine owns the list
// (its registry, terrier's repos merged in, each decorated with its
// path check, repo identity, use stats and icon), so the host reads it
// as `sm projects list` does and keeps the last answer's projects as a
// snapshot: the handful of sync callers (the git watcher, the fetch
// sweep) read the snapshot, and every async lookup that misses it
// refreshes once before calling the id unknown. The sidebar's
// projects:list refreshes on every call, and nothing learns a project
// id except from that list or a CLI verb that just wrote it, so the
// snapshot is never behind a caller that holds an id.
import {
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import type { Project, ProjectRow } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Ops from "@host/lib/engineOps";
import * as Git from "@shigomori/engine/Git";
import { handedRemotes, pickCloneUrl } from "@shared/cloneUrl";
import { dataDir, toAbsolute } from "@shared/paths";

let snapshot: readonly Project[] = [];
// The last read's rows, which the callers that asked before it began
// share.
let lastRows: readonly ProjectRow[] = [];
// The first refresh of a session re-scans projects the icon cache
// remembers as icon-less, so an icon added while the app was closed
// shows up.
let iconsRescanned = false;

// Reads run one at a time. A caller is answered by a read that started
// after it asked, never by an older one: a refresh that follows a
// registry write must see that write. Callers that asked while a read
// ran share the next one.
const reads = Semaphore.makeUnsafe(1);
let asked = 0;
let answered = 0;

// Re-reads the list.
export const refresh = Effect.suspend(() => {
  const ask = ++asked;
  return Effect.suspend(() => {
    if (answered >= ask) return Effect.succeed(lastRows);
    const covers = asked;
    return Ops.listProjects({ refreshIcons: !iconsRescanned }).pipe(
      Effect.tap((rows) =>
        Effect.sync(() => {
          iconsRescanned = true;
          lastRows = rows;
          snapshot = rows.map(toProject);
          answered = covers;
        }),
      ),
    );
  }).pipe(reads.withPermits(1));
});

// The boot's read, of the registry alone: the sync callers need only
// the projects, and the rows' git probes (each repo's identity and
// icon) would hold the app's start on every project.
export const firstList = Effect.map(Ops.listedProjects, (listed) => {
  snapshot = listed.map(toProject);
});

// Registers a repo with the engine (`sm projects add`, `--terrier` for
// `terrier`), then re-reads the list so the sync readers (the git
// watcher's reconcile right after the IPC call settles) see the new
// project.
export const addProject = Effect.fnUntraced(function* (
  path: string,
  terrier?: boolean,
) {
  const project = yield* Ops.addProject(path, terrier);
  yield* refresh;
  return project;
});

// The fields a lookup needs, without the list's decorations.
function toProject(row: Project): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    ...(row.source === undefined ? {} : { source: row.source }),
  };
}

// Points a project at its moved repo (`sm projects relocate`), then
// re-reads the list for the same reason as addProject.
export const relocateProject = Effect.fnUntraced(function* (
  id: string,
  path: string,
) {
  const project = yield* Ops.relocateProject(id, path);
  yield* refresh;
  return project;
});

// The last-read list, for the sync callers. Empty until the boot's
// first list (process/layer.ts).
export function loadProjects(): readonly Project[] {
  return snapshot;
}

// A freshly read list, for the flows that act on every project (nuke,
// the data dir move, a project's removal).
export const freshProjects = Effect.map(refresh, (rows) => rows.map(toProject));

// The sidebar's list: the rows as ProjectsList serves them.
export const listProjectsWithStatus = Effect.map(refresh, (rows) =>
  rows.map((row) =>
    Object.assign(toProject(row), {
      pathExists: row.pathExists,
      lastUsed: row.lastUsed,
      recentCount: row.recentCount,
      identity: row.identity,
      remote: row.remote,
    }),
  ),
);

class NoLocalBranchesError extends Schema.TaggedError<NoLocalBranchesError>()(
  "NoLocalBranchesError",
  { path: Schema.String },
) {
  override get message(): string {
    return `No local branches found in ${this.path}`;
  }
}

// The project's default branch, as the engine resolves it once per
// project (the configured override first), in its two senses. `ref` is
// what every row is measured against and a new worktree branches from
// ("origin/main" for a remote-tracking one), which projects:defaultBranch
// answers. `branch` is the local branch it names ("main"), which a clone
// of the project on another device checks out (sync/cloneFromPeer.ts).
export const defaultBranchOf = Effect.fnUntraced(function* (project: Project) {
  const [first] = yield* Ops.listWorktreeIdentities(
    { projectId: project.id },
    { primaryRef: true },
  );
  if (first?.primaryRef === undefined || first.primaryBranch === undefined) {
    return yield* new NoLocalBranchesError({ path: project.path });
  }
  return { ref: first.primaryRef, branch: first.primaryBranch };
});

// The URL another device should clone to get the repo at `path`.
export const handedCloneUrl = Effect.fnUntraced(function* (path: string) {
  const git = yield* Git.Git;
  const [configured, effective] = yield* Effect.all(
    [git.listConfiguredRemoteEntries(path), git.listRemoteEntries(path)],
    { concurrency: 2 },
  );
  return pickCloneUrl(handedRemotes(configured, effective));
});

// Resolves which LOCAL project a peer's project corresponds to, by repo
// identity (packages/engine/src/Identity.ts). First registry match wins: two
// local clones of the same repo are both legitimate targets, so the
// ambiguity is benign. Read fresh through the engine rather than
// trusted from the caller, so a pull can never be aimed at a
// non-matching repo.
export const findProjectByIdentity = (identity: string) =>
  Effect.map(refresh, (rows) => {
    const match = rows.find(
      (row) => row.pathExists && row.identity === identity,
    );
    return match === undefined ? undefined : toProject(match);
  });

class NoProjectOfIdentityError extends Schema.TaggedError<NoProjectOfIdentityError>()(
  "NoProjectOfIdentityError",
  {},
) {
  override get message(): string {
    return "No local project matches this repository. Add a clone of it to this device first.";
  }
}

export const findProjectByIdentityOrFail = (identity: string) =>
  Effect.flatMap(findProjectByIdentity(identity), (project) =>
    project === undefined
      ? Effect.fail(new NoProjectOfIdentityError())
      : Effect.succeed(project),
  );

// A project repo registered from inside the data dir (nothing stops
// projects.add from accepting one) would be wiped or dragged along by
// data-dir-wide operations. Nuke and the data dir move both refuse up front on
// this test. Takes the caller's already-loaded list so the guard adds
// no extra read.
export function findProjectInsideDataDir(
  projects: readonly Project[],
  roots: readonly string[] = [dataDir()],
): Project | undefined {
  return projects.find((p) =>
    roots.some((root) => isSameOrInside(toAbsolute(p.path), root)),
  );
}

// The project `projectId` names, or the entity-gone error.
export const findProject = Effect.fnUntraced(function* (projectId: string) {
  const known = snapshot.find((p) => p.id === projectId);
  if (known !== undefined) return known;
  const fresh = (yield* refresh).find((p) => p.id === projectId);
  if (fresh === undefined) return yield* new UnknownProjectError({ projectId });
  return toProject(fresh);
});

// The sidebar asks for every project's rows at once on a refresh, and
// each list runs up to six rows' probes at a time in the engine (five git
// processes a row), so a couple of lists at a time keeps a refresh from
// forking hundreds of gits at once.
const rowLists = Semaphore.makeUnsafe(2);

// A project's rows, primary first.
export const listWorktrees = (projectId: string) =>
  Ops.listWorktrees(projectId).pipe(rowLists.withPermits(1));

// The checkout `worktreeId` names, or the entity-gone error.
export const findWorktreeIdentity = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
  opts: { primaryRef?: boolean } = {},
) {
  const [identity] = yield* Ops.listWorktreeIdentities(
    { projectId, worktreeId },
    opts,
  ).pipe(
    // An id from before a move: the worktree it became.
    Effect.catchTags({
      UnknownWorktreeError: (gone) =>
        Effect.flatMap(Ops.wtFolderMovedIds, (moved) => {
          const now = moved.get(worktreeId);
          return now === undefined
            ? Effect.fail(gone)
            : Ops.listWorktreeIdentities({ projectId, worktreeId: now }, opts);
        }),
    }),
  );
  if (!identity) return yield* new UnknownWorktreeError({ worktreeId });
  return identity;
});

// The id a worktree has now, for one a peer or a mirror session may
// hold from before a move (the v3 migration's into wt/, a move, a
// rename), for a call that keys state by the id: the id itself while it
// names a worktree, else the one its worktree moved to, else the id.
export const currentWorktreeId = (projectId: string, worktreeId: string) =>
  findWorktreeIdentity(projectId, worktreeId).pipe(
    Effect.map((worktree) => worktree.id),
    Effect.catchTags({
      UnknownWorktreeError: () => Effect.succeed(worktreeId),
    }),
  );

// The preamble every worktree-scoped IPC handler opens with, so a change
// to how a worktree is resolved lands in one place.
export const findProjectAndWorktree = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
) {
  const project = yield* findProject(projectId);
  const worktree = yield* findWorktreeIdentity(project.id, worktreeId);
  return { project, worktree };
});

// The same preamble for the handlers that only need where the worktree
// is: the read-only git surface (a diff, a status, a log).
export const findWorktreePath = (scope: {
  projectId: string;
  worktreeId: string;
}) =>
  Effect.map(
    findProjectAndWorktree(scope.projectId, scope.worktreeId),
    ({ worktree }) => worktree.path,
  );
