// Sidebar collapse state: the set of project ids the user has folded
// shut. Purely a UI hint, stored in the global state.json so it survives
// across sessions (mirrors ../worktrees/shelved.ts). The toggle is a
// read-modify-write against disk, not a whole-list replace, so a stale
// renderer cache can never wipe collapse state it didn't know about.
import { readKey, writeKey } from "../config/store";

const KEY = "projectsCollapsed";

// state.json is hand-editable; a corrupt value must degrade to
// "nothing collapsed", not crash the sidebar render (packaged builds
// skip the IPC output-schema parse).
export function readCollapsedProjects(): string[] {
  const raw = readKey<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string");
}

// Returns the post-toggle list so the renderer can sync its cache to
// what actually landed on disk.
export function toggleCollapsedProject(projectId: string): string[] {
  const list = readCollapsedProjects();
  const next = list.includes(projectId)
    ? list.filter((id) => id !== projectId)
    : [...list, projectId];
  writeKey<string[]>(KEY, next);
  return next;
}

export function dropCollapsedProject(projectId: string): void {
  const list = readCollapsedProjects();
  if (!list.includes(projectId)) return;
  writeKey<string[]>(
    KEY,
    list.filter((id) => id !== projectId),
  );
}
