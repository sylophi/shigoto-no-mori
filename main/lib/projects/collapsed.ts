// Sidebar collapse state: the set of project ids the user has folded
// shut. Purely a UI hint, stored in the global state.json alongside the
// use logs rather than in registry.json: a lost collapse set costs one
// click per project to restore, which is not the kind of loss the
// registry file exists to prevent. The toggle is a read-modify-write
// against disk, not a whole-list replace, so a stale renderer cache can
// never wipe collapse state it didn't know about.
import { stateStore } from "../config/store";

const KEY = "projectsCollapsed";

// state.json is hand-editable; a corrupt value must degrade to
// "nothing collapsed", not crash the sidebar render (packaged builds
// skip the IPC output-schema parse).
function asIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string");
}

// The display read, so an unreadable state.json costs the sidebar its
// folds and nothing else.
export function readCollapsedProjects(): string[] {
  return asIdList(stateStore.readHint<unknown>(KEY, []));
}

// The same list for the two writers below, on the strict read: they
// replace the whole key, and a fallback to "nothing collapsed" would
// hand a truncated list to the write.
function readCollapsedForWrite(): string[] {
  return asIdList(stateStore.readKey<unknown>(KEY, []));
}

// Returns the post-toggle list so the renderer can sync its cache to
// what actually landed on disk.
export function toggleCollapsedProject(projectId: string): string[] {
  const list = readCollapsedForWrite();
  const next = list.includes(projectId)
    ? list.filter((id) => id !== projectId)
    : [...list, projectId];
  stateStore.writeKey<string[]>(KEY, next);
  return next;
}

export function dropCollapsedProject(projectId: string): void {
  const list = readCollapsedForWrite();
  if (!list.includes(projectId)) return;
  stateStore.writeKey<string[]>(
    KEY,
    list.filter((id) => id !== projectId),
  );
}
