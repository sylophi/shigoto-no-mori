// A set of worktree ids stored under one registry.json key: the shelf,
// the auto-pull marks. One implementation so the lock discipline and
// the "nothing to write" rule live in one place, and so the flows that
// rekey a worktree (relocate, a data-dir move) can carry every mark
// the same way (marks.ts).
import { registryStore } from "../config/store";

type IdMap = Record<string, true>;

const isMarked = (map: Record<string, boolean>, worktreeId: string) =>
  map[worktreeId] === true;

export interface RegistryIdSet {
  has(worktreeId: string): boolean;
  // Bulk lookup form: read the file once for callers that check many
  // ids in a row (the worktree list build). Returned set is owned by
  // the caller.
  readSet(): Set<string>;
  set(worktreeId: string, on: boolean): void;
  drop(worktreeId: string): void;
  // Carry the mark from one id to another, for a worktree whose path
  // (and so id) changed. A no-op when `from` is unmarked.
  move(from: string, to: string): void;
}

export function makeRegistryIdSet(key: string): RegistryIdSet {
  // The display read: a hand-mangled mark set costs the badges it
  // holds, not the worktree list of every project (the key is global,
  // and the list build reads it for each row). The CLI's
  // readRegistryMarkSet degrades the same way. The writers below read
  // under the strict rule, so a write never rebuilds the key out of
  // the fallback. Only ids marked true count, as in the CLI.
  const readMap = () =>
    registryStore.readHint<Record<string, boolean>>(key, {});
  // updateKey so the current map is read under the cross-process lock.
  // The CLI rewrites registry.json too (its own keys, preserving the
  // rest), and a read-outside-the-lock version would clobber that.
  const set = (worktreeId: string, on: boolean) => {
    registryStore.updateKey<IdMap>(key, {}, (map) => {
      if ((map[worktreeId] === true) === on) return undefined;
      if (on) {
        map[worktreeId] = true;
      } else {
        delete map[worktreeId];
      }
      return map;
    });
  };
  return {
    has: (worktreeId) => isMarked(readMap(), worktreeId),
    readSet: () => {
      const map = readMap();
      return new Set(Object.keys(map).filter((id) => isMarked(map, id)));
    },
    set,
    drop: (worktreeId) => set(worktreeId, false),
    move: (from, to) => {
      registryStore.updateKey<IdMap>(key, {}, (map) => {
        if (map[from] !== true) return undefined;
        delete map[from];
        map[to] = true;
        return map;
      });
    },
  };
}
