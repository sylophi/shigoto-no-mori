// Shelf state for worktrees: a flat set of worktree ids that the user
// has chosen to hide from the sidebar's main list. Purely a UI hint --
// the worktree itself is untouched on disk, and nothing per-worktree
// (scripts, ports, processes) is stopped. Stored in the global
// registry.json alongside the project list, since rebuilding a shelf by
// hand means remembering which of dozens of worktrees were hidden. Not
// in the per-project shigomori config: "what's currently in focus" is a
// per-user, per-machine thing rather than a property of the repo.
import { registryStore, SHELVED_KEY } from "../config/store";

type ShelvedMap = Record<string, true>;

function readMap(): ShelvedMap {
  return registryStore.readKey<ShelvedMap>(SHELVED_KEY, {});
}

export function isShelved(worktreeId: string): boolean {
  return readMap()[worktreeId] === true;
}

// Bulk lookup form: read the file once for callers that need to check
// many ids in a row (the worktree list build). Mirrors `usageFor` in
// packageScriptStats.ts. Returned set is owned by the caller.
export function readShelvedSet(): Set<string> {
  return new Set(Object.keys(readMap()));
}

// updateKey so the current map is read under the cross-process lock --
// the CLI mutates this key too, and a read-outside-the-lock
// version would clobber a concurrent CLI write.
export function setShelved(worktreeId: string, shelved: boolean): void {
  registryStore.updateKey<ShelvedMap>(SHELVED_KEY, {}, (map) => {
    if ((map[worktreeId] === true) === shelved) return undefined;
    if (shelved) {
      map[worktreeId] = true;
    } else {
      delete map[worktreeId];
    }
    return map;
  });
}

export function dropShelved(worktreeId: string): void {
  setShelved(worktreeId, false);
}
