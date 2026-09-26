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
import { unknownProjectError } from "@shared/errors";
import { isSameOrInside } from "@shared/git/worktreeLayout";
import type { Project, ProjectRow } from "@shared/schemas";
import { listProjectsViaCli, projectsAddViaCli } from "@host/ipc/cliDelegate";
import {
  findWorktreeIdentityOrThrow,
  listWorktreeIdentities,
  type WorktreeIdentity,
} from "../git/worktrees";
import { dataDir, toAbsolute } from "../util/paths";

let snapshot: readonly ProjectRow[] = [];
// The first list of a session re-scans projects the icon cache
// remembers as icon-less, so an icon added while the app was closed
// shows up.
let iconsRescanned = false;
let running: Promise<readonly ProjectRow[]> | null = null;
let queued: Promise<readonly ProjectRow[]> | null = null;

async function listOnce(): Promise<readonly ProjectRow[]> {
  const rows = await listProjectsViaCli({ refreshIcons: !iconsRescanned });
  iconsRescanned = true;
  snapshot = rows;
  return rows;
}

// Re-reads the list. A caller arriving while a read is in flight waits
// for one that starts after it, never for the older answer: a refresh
// that follows a registry write must see that write.
export function refreshProjects(): Promise<readonly ProjectRow[]> {
  if (running === null) {
    running = listOnce().finally(() => {
      running = null;
    });
    return running;
  }
  queued ??= running
    .catch(() => undefined)
    .then(() => {
      queued = null;
      return refreshProjects();
    });
  return queued;
}

// Registers a repo through the CLI (`sm projects add`), then re-reads
// the list so the sync readers (the git watcher's reconcile right after
// the IPC call settles) see the new project.
export async function registerProject(path: string): Promise<Project> {
  const project = await projectsAddViaCli(path);
  await refreshProjects();
  return project;
}

// The fields a lookup needs, without the list's decorations.
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    ...(row.source === undefined ? {} : { source: row.source }),
  };
}

// The last-read list, for the sync callers. Empty until the first
// refresh (main awaits one at boot).
export function loadProjects(): Project[] {
  return snapshot.map(toProject);
}

// A freshly read list, for the flows that act on every project (nuke,
// the data dir move).
export async function listProjects(): Promise<Project[]> {
  return (await refreshProjects()).map(toProject);
}

// The sidebar's list: the rows as ProjectsList serves them.
export async function listProjectsWithStatus(): Promise<Project[]> {
  const rows = await refreshProjects();
  return rows.map((row) =>
    Object.assign(toProject(row), {
      pathExists: row.pathExists,
      lastUsed: row.lastUsed,
      recentCount: row.recentCount,
      identity: row.identity,
    }),
  );
}

// The primary ref every row of a project is measured against, which
// the CLI resolves once per project (the configured override first):
// what projects:defaultBranch answers, and what a clone of the project
// on another device is made of (host/lib/sync/cloneFromPeer.ts).
export async function primaryRefOf(project: Project): Promise<string> {
  const [first] = await listWorktreeIdentities(project.id, {
    primaryRef: true,
  });
  if (first?.primaryRef === undefined) {
    throw new Error(`No local branches found in ${project.path}`);
  }
  return first.primaryRef;
}

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
  projects: Project[],
): Project | undefined {
  const root = dataDir();
  return projects.find((p) => isSameOrInside(toAbsolute(p.path), root));
}

export async function findProjectOrThrow(projectId: string): Promise<Project> {
  const known = snapshot.find((p) => p.id === projectId);
  if (known !== undefined) return toProject(known);
  const fresh = (await refreshProjects()).find((p) => p.id === projectId);
  if (fresh === undefined) throw unknownProjectError(projectId);
  return toProject(fresh);
}

// The preamble every worktree-scoped IPC handler opens with, so a change
// to how a worktree is resolved lands in one place.
export async function findProjectAndWorktreeOrThrow(
  projectId: string,
  worktreeId: string,
): Promise<{ project: Project; worktree: WorktreeIdentity }> {
  const project = await findProjectOrThrow(projectId);
  const worktree = await findWorktreeIdentityOrThrow(project.id, worktreeId);
  return { project, worktree };
}

// The same preamble for the handlers that only need where the worktree
// is: the read-only git surface (a diff, a status, a log).
export async function findWorktreePathOrThrow({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}): Promise<string> {
  const { worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  return worktree.path;
}
