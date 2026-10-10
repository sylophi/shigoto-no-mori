import {
  type Project,
  type Worktree,
  WorktreeSchema,
} from "@shigomori/contracts/schemas";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import {
  endWith,
  hostViewAtom,
  layOver,
  optimisticView,
  overlay,
  type ViewState,
} from "@/lib/runtime/atoms";
import {
  type LiveViewState,
  useView,
  useViews,
  viewsOf,
} from "@/lib/runtime/viewHooks";
import { noteWorktreeList } from "@/lib/viewFeed";

// The key of one device's project's list.
export const worktreeListKey = (deviceId: string, projectId: string) =>
  `${deviceId}\n${projectId}`;

// One device's project's worktrees, as its host streams them
// (worktrees:watch), told to the watchers of every list
// (lib/viewFeed.ts) as they come.
export const worktreesAtom = Atom.family((key: string) => {
  const [deviceId = "", projectId = ""] = key.split("\n");
  return hostViewAtom({
    deviceId,
    localDeviceId,
    channel: "worktrees:watch",
    input: { projectId },
    schema: Schema.Array(WorktreeSchema),
    onValue: (list) => noteWorktreeList({ key, deviceId, list }),
    onStop: () => noteWorktreeList({ key, deviceId, list: null }),
  });
});

// The list as shown: the stream's, with a row change on its way, or a
// row the host just made or removed (useWorktreeMutations.ts), laid
// over it.
const shownWorktreesAtom = Atom.family((key: string) =>
  optimisticView(worktreesAtom(key)),
);

// The view of the worktree's list on that device, and the list shown.
const listOf = (deviceId: string, projectId: string) => {
  const key = worktreeListKey(deviceId, projectId);
  return { view: worktreesAtom(key), shown: shownWorktreesAtom(key) };
};

// A row the host answered a change with, shown in its list until the
// list's next value: a working-tree change (a discard, a restore) moves
// no ref, so the view may not read again for a while.
export function writeBackWorktree(
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  worktree: Worktree,
): void {
  const { view, shown } = listOf(deviceId, worktree.projectId);
  layOver(
    registry,
    shown,
    view,
    (list) => list.map((w) => (w.id === worktree.id ? worktree : w)),
    "next",
  );
}

// A new or re-keyed worktree (in place of `replacesId`, the id it had
// before a convert or move) shown in its list until the host's view has
// it: the callers route onto the row's page as soon as the mutation
// resolves. The counterpart of forgetWorktreeRows.
export function spliceWorktreeRow(
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  worktree: Worktree,
  replacesId?: string,
): void {
  const { view, shown } = listOf(deviceId, worktree.projectId);
  layOver(
    registry,
    shown,
    view,
    (list) => {
      // In place, so the sidebar row and the sibling order don't shift.
      const at = list.findIndex(
        (w) => w.id === worktree.id || w.id === replacesId,
      );
      return at === -1 ? [...list, worktree] : list.with(at, worktree);
    },
    { caughtUp: (list) => list.some((w) => w.id === worktree.id) },
  );
}

// A row changed by a call, shown changed while the call runs, then as
// the host answered until the list's next value; as it was if the call
// failed.
export function changeWorktreeRow(
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  projectId: string,
  worktreeId: string,
  patch: (worktree: Worktree) => Worktree,
): { answered: (worktree: Worktree) => void; failed: () => void } {
  const { view, shown } = listOf(deviceId, projectId);
  const laid = overlay(registry, shown, (list) =>
    list.map((w) => (w.id === worktreeId ? patch(w) : w)),
  );
  return {
    answered: (worktree) => {
      laid.replace((list) =>
        list.map((w) => (w.id === worktree.id ? worktree : w)),
      );
      endWith(registry, view, laid, "next");
    },
    failed: () => laid.end(true),
  };
}

// Removed worktrees gone from their list at once, until the host's view
// drops them too: a caller routing off a deleted row must not read it.
export function forgetWorktreeRows(
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  projectId: string,
  worktreeIds: readonly string[],
): void {
  const { view, shown } = listOf(deviceId, projectId);
  const gone = (w: Worktree) => worktreeIds.includes(w.id);
  layOver(registry, shown, view, (list) => list.filter((w) => !gone(w)), {
    caughtUp: (list) => !list.some(gone),
  });
}

// A device's project's worktrees: nothing is read with no project, for
// a device with no host behind it (a peer without a session, the web
// client's own scope), or while `enabled` holds it off.
export function useDeviceWorktrees(
  deviceId: string,
  projectId: string | null,
  enabled = true,
): LiveViewState<readonly Worktree[]> {
  return useView(
    enabled && projectId !== null && deviceId !== ""
      ? shownWorktreesAtom(worktreeListKey(deviceId, projectId))
      : null,
  );
}

export function useWorktrees(projectId: string | null) {
  const { deviceId, hasHost } = useHostScope();
  return useDeviceWorktrees(deviceId, projectId, hasHost);
}

// Every listed project's worktrees on one device, positionally aligned
// with `projects`. A project whose path is gone is skipped, since git
// would just ENOENT.
export const someWorktreesAtom = viewsOf((key) => shownWorktreesAtom(key));

export function useAllProjectWorktrees(
  projects: readonly Project[],
): readonly ViewState<readonly Worktree[]>[] {
  const { deviceId, hasHost } = useHostScope();
  return useViews(
    someWorktreesAtom,
    projects.map((project) =>
      hasHost && project.pathExists !== false
        ? worktreeListKey(deviceId, project.id)
        : null,
    ),
  );
}
