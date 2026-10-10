// What the window's worktree and project views stream
// (hooks/worktrees/useWorktrees.ts, hooks/projects/useProjects.ts), for
// the watchers that read all of them outside React: the villager news
// and its album (lib/villagers/), and the agents waiting on you
// (lib/agentWatch.ts). A list is heard from its first value on, and
// heard to go when its stream stops, after which its next value starts
// it over.
import type { Project, Worktree } from "@shigomori/contracts/schemas";

export type WorktreeListEvent = {
  readonly key: string;
  readonly deviceId: string;
  // Null once the list's stream has stopped.
  readonly list: readonly Worktree[] | null;
};

const listeners = new Set<(event: WorktreeListEvent) => void>();
const lists = new Map<
  string,
  { deviceId: string; list: readonly Worktree[] }
>();
const projects = new Map<string, readonly Project[]>();

export function onWorktreeLists(
  listener: (event: WorktreeListEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteWorktreeList(event: WorktreeListEvent): void {
  if (event.list === null) lists.delete(event.key);
  else lists.set(event.key, { deviceId: event.deviceId, list: event.list });
  for (const listener of listeners) listener(event);
}

// Every worktree list streaming now, with the device it is from.
export function heldWorktreeLists(): readonly {
  deviceId: string;
  list: readonly Worktree[];
}[] {
  return [...lists.values()];
}

export function noteProjects(
  deviceId: string,
  list: readonly Project[] | null,
): void {
  if (list === null) projects.delete(deviceId);
  else projects.set(deviceId, list);
}

// A device's projects as its view last streamed them.
export function heldProjects(deviceId: string): readonly Project[] | undefined {
  return projects.get(deviceId);
}
