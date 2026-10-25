// A device's worktree lifecycle as its host pushes it: the in-flight
// create phase (so the detail page can show a banner: carrying over /
// setting up / provisioning ports, and the carry-over toasts can fire
// after the call has already returned), and a removal under way, so a
// worktree on its way out reads as deleting to every window and not
// only to the one that pressed the button (a mirror stop, a
// transplant's source teardown, the CLI's unmirror all remove through
// the same host delete). The create phases stream to the caller, so
// only this machine's atom hears them, while a peer's carries the
// peer's removals.
import { useAtomValue } from "@effect/atom-react";
import { callOf } from "@shigomori/contracts/contract";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type {
  CreatePhase,
  WorktreeCarryOverComplete,
  WorktreeRemoval,
} from "@shigomori/contracts/schemas";
import { pluralize } from "@shigomori/contracts/words";
import type { QueryClient } from "@tanstack/react-query";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import {
  forgetDeletedWorktree,
  isOwnDeletePending,
} from "@/hooks/worktrees/useWorktreeMutations";
import { queryKeysFor, worktreeQueriesOn } from "@/lib/queryKeys";
import type { ClientLinks } from "@/lib/runtime/ClientLinks";
import {
  accountsLeftAtom,
  clientAtoms,
  heard,
  hostPushes,
  localDeviceIdAtom,
  hostSessionAtom,
  queryClientAtom,
} from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { toast } from "@/lib/toast";

// The phase as the detail page's banner reads it. The pull dialogs
// word the same phases as steps of their own run (flow/PullProgress.tsx
// rows, pullSteps.ts headlines).
export const CREATE_PHASE_LABEL = {
  carryOver: "Carrying over files...",
  setup: "Setting up...",
  portPoolProvision: "Provisioning ports...",
} satisfies Record<CreatePhase, string>;

type Lifecycle = {
  readonly phases: ReadonlyMap<string, CreatePhase>;
  readonly removing: ReadonlySet<string>;
};

const NOTHING: Lifecycle = { phases: new Map(), removing: new Set() };

function clippedLines(lines: readonly string[], max: number): string {
  const shown = lines.slice(0, max);
  const more = lines.length - shown.length;
  return shown.join("\n") + (more > 0 ? `\n...and ${more} more` : "");
}

function withRemoval(state: Lifecycle, removal: WorktreeRemoval): Lifecycle {
  const removing = removal.state === "removing";
  if (removing === state.removing.has(removal.worktreeId)) return state;
  const next = new Set(state.removing);
  if (removing) next.add(removal.worktreeId);
  else next.delete(removal.worktreeId);
  return { ...state, removing: next };
}

function withPhase(
  state: Lifecycle,
  worktreeId: string,
  phase: CreatePhase | null,
): Lifecycle {
  if ((state.phases.get(worktreeId) ?? null) === phase) return state;
  const next = new Map(state.phases);
  if (phase === null) next.delete(worktreeId);
  else next.set(worktreeId, phase);
  return { ...state, phases: next };
}

// A removal announced by any device (this machine or a peer) gets the
// treatment this window's own delete gives its worktree: its in-flight
// fetches cancelled as the delete starts (settled, they would answer
// "Unknown worktree" and toast), and its row and queries dropped the
// moment it is gone, for every viewer at once. This window's own
// delete is left to its mutation, which forgets the row and routes off
// it together once the invoke replies.
function followRemoval(
  queryClient: QueryClient,
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  removal: WorktreeRemoval,
): void {
  if (isOwnDeletePending(queryClient, deviceId, removal.worktreeId)) return;
  if (removal.state === "removing") {
    void queryClient.cancelQueries({
      predicate: worktreeQueriesOn(deviceId, removal.worktreeId),
    });
  } else if (removal.state === "removed") {
    forgetDeletedWorktree(
      queryClient,
      registry,
      deviceId,
      removal.projectId,
      removal.worktreeId,
    );
  }
}

// What a carry-over did that its caller has long stopped waiting for.
// The host rewrote project.json (carry-over entries removed in favor of
// .worktreeinclude), so the caches that mirror it are dropped and open
// views refresh.
function tellCarryOver(
  queryClient: QueryClient,
  deviceId: string,
  evt: WorktreeCarryOverComplete,
): void {
  const removed = evt.removedCarryOverPaths ?? [];
  if (removed.length > 0) {
    const keys = queryKeysFor(deviceId);
    void queryClient.invalidateQueries({
      queryKey: keys.shigomoriConfig(evt.projectId),
    });
    void queryClient.invalidateQueries({
      queryKey: keys.worktreeIncludeStatus(evt.projectId),
    });
    toast.info(
      `.worktreeinclude replaced ${pluralize(removed.length, "carry-over entry", "carry-over entries")}`,
      {
        description:
          "The repo's .worktreeinclude file now covers these paths, so " +
          "their manual carry-over entries were removed:\n" +
          clippedLines(removed, 4),
      },
    );
  }
  const { applied, failures } = evt.report;
  const includeFailures = evt.report.includeFailures ?? [];
  if (includeFailures.length > 0) {
    toast.warning("Couldn't resolve .worktreeinclude", {
      description: clippedLines(
        includeFailures.map((f) =>
          f.source ? `${f.source}: ${f.reason}` : f.reason,
        ),
        4,
      ),
    });
  }
  const sourced = evt.report.sourced ?? [];
  if (sourced.length > 0) {
    toast.info("Carried over from other worktrees", {
      description: clippedLines(
        sourced.map(
          (s) =>
            `${s.path} from ${s.source}${
              s.copiedInstead
                ? " (copied: symlinks only target the main checkout)"
                : ""
            }`,
        ),
        4,
      ),
    });
  }
  if (failures.length === 0) return;
  toast.warning(
    `Carried over ${applied} of ${applied + failures.length} entries`,
    {
      description: clippedLines(
        failures.map(
          (f) => `${f.path}${f.source ? ` in ${f.source}` : ""}: ${f.reason}`,
        ),
        4,
      ),
    },
  );
}

// The boot mounts this machine's where it has a host, and a peer's from
// the moment its session lands until the account goes: a row a mirror
// folds away is never drawn, so nothing else would listen before the
// peer announces the copy's removal, and a push is not replayed. It
// starts over on each new session to the device's host, since the wire
// may drop, or the host die, between a removal's or a setup's start
// and its close, and the close is not replayed. For a peer, the
// session-landed sweep refetches the device's listing, which then says
// whether the worktree is still there.
export const worktreeLifecycleAtom = Atom.family((deviceId: string) =>
  clientAtoms.atom(
    (get) => {
      const localDeviceId = get(localDeviceIdAtom);
      const local = deviceId === localDeviceId;
      get(hostSessionAtom(deviceId));
      if (!local) get(accountsLeftAtom);
      const queryClient = get(queryClientAtom);
      const registry = get.registry;
      const pushes = <K extends "removal" | "lifecyclePhase">(key: K) =>
        hostPushes(deviceId, localDeviceId, callOf(worktreesContract, key));
      let state = NOTHING;
      const removals = pushes("removal").pipe(
        Stream.tap((removal) =>
          heard("removal", () => {
            state = withRemoval(state, removal);
            // Every removal, a close whose start this atom never heard
            // included (a peer's session started over, a reload
            // mid-delete): what it forgets it forgets once.
            if (queryClient !== null) {
              followRemoval(queryClient, registry, deviceId, removal);
            }
          }),
        ),
      );
      // Starting over shows nothing held until a push says otherwise.
      const states = (events: Stream.Stream<unknown, never, ClientLinks>) =>
        Stream.concat(
          Stream.make(NOTHING),
          events.pipe(Stream.map(() => state)),
        );
      if (!local) return states(removals);
      const phases = pushes("lifecyclePhase").pipe(
        Stream.tap(({ worktreeId, phase }) =>
          heard("lifecycle phase", () => {
            state = withPhase(
              state,
              worktreeId,
              phase === "idle" ? null : phase,
            );
          }),
        ),
      );
      const carryOvers = hostPushes(
        deviceId,
        localDeviceId,
        callOf(worktreesContract, "carryOverComplete"),
      ).pipe(
        Stream.tap((evt) =>
          heard("carry-over", () => {
            if (queryClient !== null) tellCarryOver(queryClient, deviceId, evt);
          }),
        ),
      );
      return states(
        removals.pipe(Stream.merge(phases), Stream.merge(carryOvers)),
      );
    },
    { initialValue: NOTHING },
  ),
);

const lifecycleOf = (result: AsyncResult.AsyncResult<Lifecycle, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : NOTHING;

// Null asks for nothing: a page whose worktree lives on a peer has no
// local create lifecycle to follow.
export function useWorktreeCreatePhase(
  worktreeId: string | null,
): CreatePhase | null {
  return useAtomValue(
    worktreeLifecycleAtom(useApi().deviceId),
    (result) =>
      (worktreeId === null
        ? undefined
        : lifecycleOf(result).phases.get(worktreeId)) ?? null,
  );
}

// Whether the device is in the middle of removing the worktree, as
// its host announced it. `deviceId` names the peer a remote row or
// page belongs to, or this machine.
export function useWorktreeRemoving(
  worktreeId: string,
  deviceId: string,
): boolean {
  return useAtomValue(worktreeLifecycleAtom(deviceId), (result) =>
    lifecycleOf(result).removing.has(worktreeId),
  );
}
