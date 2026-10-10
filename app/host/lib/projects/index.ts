// The host's view of the registered projects. The CLI owns the list
// (registry.json, terrier's repos merged in, each decorated with its
// path check, repo identity, use stats and icon), so the host reads it
// through `sm projects list` and keeps the last answer as a snapshot:
// the handful of sync callers (the git watcher, the fetch sweep) read
// the snapshot, and every async lookup that misses it refreshes once
// before calling the id unknown. The sidebar's projects:list refreshes
// on every call, and nothing learns a project id except from that list
// or a CLI verb that just wrote it, so the snapshot is never behind a
// caller that holds an id.
import { UnknownProjectError } from "@shigomori/contracts/errors";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import type { Project, ProjectRow } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { face } from "@host/lib/engineCalls";
import * as Ops from "@host/lib/engineOps";
import { findWorktreeIdentity } from "../git/worktrees";
import { dataDir, toAbsolute } from "../util/paths";

let snapshot: readonly ProjectRow[] = [];
// The first list of a session re-scans projects the icon cache
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
    if (answered >= ask) return Effect.succeed(snapshot);
    const covers = asked;
    return Ops.listProjects({ refreshIcons: !iconsRescanned }).pipe(
      Effect.tap((rows) =>
        Effect.sync(() => {
          iconsRescanned = true;
          snapshot = rows;
          answered = covers;
        }),
      ),
    );
  }).pipe(reads.withPermits(1));
});

// Registers a repo with the engine (`sm projects add`), then re-reads
// the list so the sync readers (the git watcher's reconcile right after
// the IPC call settles) see the new project.
export const addProject = Effect.fnUntraced(function* (path: string) {
  const project = yield* Ops.addProject(path);
  yield* refresh;
  return project;
});

// The fields a lookup needs, without the list's decorations.
function toProject(row: ProjectRow): Project {
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

// The last-read list, for the sync callers. Empty until the first
// refresh (main awaits one at boot).
export function loadProjects(): readonly Project[] {
  return snapshot.map(toProject);
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

// The primary ref every row of a project is measured against, which
// the CLI resolves once per project (the configured override first):
// what projects:defaultBranch answers, and what a clone of the project
// on another device is made of (host/lib/sync/cloneFromPeer.ts).
export const primaryRef = Effect.fnUntraced(function* (project: Project) {
  const [first] = yield* Ops.listWorktreeIdentities(
    { projectId: project.id },
    { primaryRef: true },
  );
  if (first?.primaryRef === undefined) {
    return yield* new NoLocalBranchesError({ path: project.path });
  }
  return first.primaryRef;
});

// Resolves which LOCAL project a peer's project corresponds to, by repo
// identity (shared/git/repoIdentity.mts). First registry match wins: two
// local clones of the same repo are both legitimate targets, so the
// ambiguity is benign. Read fresh from disk through the CLI rather than
// trusted from the caller, so a pull can never be aimed at a
// non-matching repo.
export async function findProjectByIdentity(
  identity: string,
): Promise<Project | undefined> {
  const rows = await refreshProjects();
  const match = rows.find((row) => row.pathExists && row.identity === identity);
  return match === undefined ? undefined : toProject(match);
}

const NO_PROJECT_OF_IDENTITY =
  "No local project matches this repository. Add a clone of it to this device first.";

export async function findProjectByIdentityOrThrow(
  identity: string,
): Promise<Project> {
  const project = await findProjectByIdentity(identity);
  if (project === undefined) throw new Error(NO_PROJECT_OF_IDENTITY);
  return project;
}

// A project repo registered from inside the data dir (nothing stops
// projects.add from accepting one) would be wiped or dragged along by
// data-dir-wide operations. Nuke and the data dir move both refuse up front on
// this test. Takes the caller's already-loaded list so the guard adds
// no extra read.
export function findProjectInsideDataDir(
  projects: readonly Project[],
): Project | undefined {
  const root = dataDir();
  return projects.find((p) => isSameOrInside(toAbsolute(p.path), root));
}

// The project `projectId` names, or the entity-gone error.
export const findProject = Effect.fnUntraced(function* (projectId: string) {
  const known = snapshot.find((p) => p.id === projectId);
  if (known !== undefined) return toProject(known);
  const fresh = (yield* refresh).find((p) => p.id === projectId);
  if (fresh === undefined) return yield* new UnknownProjectError({ projectId });
  return toProject(fresh);
});

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

// The Promise forms, for the host code not converted yet: removed with
// the narrowed engine face (engineCalls.ts) in step 7's B4c PR.
export const refreshProjects = face(() => refresh);
export const registerProject = face(addProject);
export const listProjects = face(() => freshProjects);
export const primaryRefOf = face(primaryRef);
export const findProjectOrThrow = face(findProject);
export const findProjectAndWorktreeOrThrow = face(findProjectAndWorktree);
export const findWorktreePathOrThrow = face(findWorktreePath);
