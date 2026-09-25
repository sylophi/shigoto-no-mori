// Shelf state for worktrees: a flat set of worktree ids that the user
// has chosen to hide from the sidebar's main list. Purely a UI hint.
// The worktree itself is untouched on disk, and nothing per-worktree
// (scripts, ports, processes) is stopped. Stored in the global
// registry.json alongside the project list, since rebuilding a shelf by
// hand means remembering which of dozens of worktrees were hidden. Not
// in the per-project shigomori config: "what's currently in focus" is a
// per-user, per-machine thing rather than a property of the repo. The
// CLI mutates this key too (shelve, unshelve, and the drop on rm).
import { SHELVED_KEY } from "../config/store";
import { makeRegistryIdSet } from "./registryIdSet";

export const shelvedMarks = makeRegistryIdSet(SHELVED_KEY);

export const isShelved = shelvedMarks.has;
export const readShelvedSet = shelvedMarks.readSet;
export const setShelved = shelvedMarks.set;
export const dropShelved = shelvedMarks.drop;
