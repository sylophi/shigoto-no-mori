// The host's view of the registered projects. The engine owns the list
// (its registry, terrier's repos merged in, each decorated with its
// path check, repo identity, use stats and icon), so the host reads it
// as `sm projects list` does and keeps the last answer's projects as a
// snapshot for the handful of sync callers (the git watcher, the fetch
// sweep). A lookup by id asks the engine, and the sidebar's
// projects:list refreshes the snapshot on every call.
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import type {
  Project,
  ProjectRow,
  Worktree,
} from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Git from "@shigomori/engine/Git";
import * as Projects from "@shigomori/engine/Projects";
import * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import { handedRemotes, pickCloneUrl } from "@shared/cloneUrl";
import { toAbsolute } from "@shared/paths";
import { changing } from "../Engine";

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
    return Effect.flatMap(Registry.Registry, (registry) =>
      registry.rows({ rescanIconMisses: !iconsRescanned }),
    ).pipe(
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
export const firstList = Effect.flatMap(Registry.Registry, (registry) =>
  Effect.map(registry.listed, (listed) => {
    snapshot = listed.map(toProject);
  }),
);

// Registers a repo with the engine (`sm projects add`, `--terrier` for
// `terrier`), then re-reads the list so the sync readers (the git
// watcher's reconcile right after the IPC call settles) see the new
// project.
export const addProject = Effect.fnUntraced(function* (
  path: string,
  terrier?: boolean,
) {
  const project = yield* (yield* Projects.Projects).add(path, { terrier });
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
  // Its worktrees reconnected too.
  const project = yield* changing(
    Effect.gen(function* () {
      const registered = yield* findProject(id);
      return yield* (yield* Worktrees.Worktrees).relocateProject(
        registered,
        path,
      );
    }),
    { projectId: id },
  );
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
  const { rows } = yield* (yield* Worktrees.Worktrees).identityList([project], {
    primaryRef: true,
  });
  const [first] = rows;
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
  findProjectByIdentity(identity).pipe(
    Effect.filterOrFail(
      (project) => project !== undefined,
      () => new NoProjectOfIdentityError(),
    ),
  );

// A project repo registered from inside the data dir (nothing stops
// projects.add from accepting one) would be wiped or dragged along by
// data-dir-wide operations. Nuke and the data dir move both refuse up front on
// this test. Takes the caller's already-loaded list so the guard adds
// no extra read.
export function findProjectInsideDataDir(
  projects: readonly Project[],
  roots: readonly string[],
): Project | undefined {
  return projects.find((p) =>
    roots.some((root) => isSameOrInside(toAbsolute(p.path), root)),
  );
}

// The project `projectId` names, or the entity-gone error.
export const findProject = Effect.fnUntraced(function* (projectId: string) {
  const worktrees = yield* Worktrees.Worktrees;
  return yield* worktrees.resolveProjectById(
    yield* worktrees.nowhere,
    projectId,
  );
});

// The sidebar asks for every project's rows at once on a refresh, and
// each list runs up to six rows' probes at a time in the engine (five git
// processes a row), so a couple of lists at a time keeps a refresh from
// forking hundreds of gits at once.
const rowLists = Semaphore.makeUnsafe(2);

// The contract's row: the terminal's project name and its sessions'
// permission prompts are left out.
export const hostWorktree = ({
  projectName: _projectName,
  agentSessions,
  ...row
}: Worktrees.WorktreeRow): Worktree => ({
  ...row,
  agentSessions: agentSessions.map(({ waits: _waits, ...session }) => session),
});

// A project's rows, primary first: the sidebar's list. A project whose
// checkouts git can't list reads as having none, as the terminal's
// listing skips it.
export const listWorktrees = (projectId: string) =>
  Effect.gen(function* () {
    const project = yield* findProject(projectId);
    const listing = yield* (yield* Worktrees.Worktrees).list([project]);
    return listing.rows.map(hostWorktree);
  }).pipe(rowLists.withPermits(1));

// One row, freshly probed: what a change hands back to the renderer.
export const worktreeRow = (located: Worktrees.Located) =>
  Effect.map(
    Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
      worktrees.row(located, { settle: true }),
    ),
    hostWorktree,
  );

// The checkout `worktreeId` names as the contract's identity, or the
// entity-gone error.
export const findWorktreeIdentity = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
  opts: { primaryRef?: boolean } = {},
) {
  const located = yield* findProjectAndWorktree(projectId, worktreeId);
  return yield* (yield* Worktrees.Worktrees).identityRow(located, {
    primaryRef: opts.primaryRef === true,
  });
});

// The id a worktree has now, for one a peer or a mirror session may
// hold from before a move (the v3 migration's into wt/, a move, a
// rename), for a call that keys state by the id: the id itself while it
// names a worktree, else the one its worktree moved to, else the id.
export const currentWorktreeId = (projectId: string, worktreeId: string) =>
  findProjectAndWorktree(projectId, worktreeId).pipe(
    Effect.map(({ worktree }) => worktree.id),
    Effect.catchTags({
      UnknownWorktreeError: () => Effect.succeed(worktreeId),
    }),
  );

// The preamble every worktree-scoped handler opens with, so a change to
// how a worktree is resolved lands in one place: the worktree an id
// names, or the one it moved to, with its project, which the engine's
// verbs then run on.
export const findProjectAndWorktree = Effect.fnUntraced(function* (
  projectId: string,
  worktreeId: string,
) {
  const worktrees = yield* Worktrees.Worktrees;
  return yield* worktrees.resolveById(yield* worktrees.nowhere, {
    projectId,
    worktreeId,
  });
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
