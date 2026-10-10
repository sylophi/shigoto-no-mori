import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { StackCleanupFailure } from "@shigomori/ui/views/worktreeDetail/pullRequests/ClosedPullRequestBoxView.tsx";
import type {
  CreateWorktreeResult,
  DeleteWorktreeResult,
  Worktree,
} from "@shigomori/contracts/schemas";
import {
  errorMessageOf,
  isCommandRefusedError,
} from "@shigomori/contracts/errors";
import type { ReadyStackCleanupDevice } from "@/hooks/pullRequests/useStackCleanup";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { worktreeQueriesOn } from "@/lib/queryKeys";
import { useRegistry } from "@/lib/runtime/viewHooks";
import {
  changeWorktreeRow,
  forgetWorktreeRows,
  spliceWorktreeRow,
} from "@/hooks/worktrees/useWorktrees";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { useScriptRuns } from "@/hooks/scripts/useScriptRuns";
import { scriptRunsFor } from "@/store/scriptRuns";
import { useWorktreeRemoving } from "@/store/worktreeLifecycle";
import type { QueryClient } from "@tanstack/react-query";

interface CreateWorktreeInput {
  projectId: string;
  worktreeName?: string;
  branchName?: string;
  base?: string;
  checkout?: boolean;
}

// A made or re-keyed worktree is shown in its list at once
// (spliceWorktreeRow): the callers route onto its page as the mutation
// resolves. The villager news hears it once the host's list has it
// (lib/villagers/moves.ts).
export function useCreateWorktree() {
  const registry = useRegistry();
  const { api, deviceId } = useHostScope();
  return useMutation<CreateWorktreeResult, Error, CreateWorktreeInput>({
    mutationFn: (input) => api.worktrees.create(input),
    onSuccess: (result) => {
      spliceWorktreeRow(registry, deviceId, result.worktree);
    },
    meta: { errorTitle: "Couldn't create worktree" },
  });
}

interface CreateWorktreeFromPullRequestInput {
  projectId: string;
  worktreeName?: string;
  number: number;
  cloneFiles?: boolean;
}

// Two calls behind one mutation: land the PR head on a local branch,
// then create the worktree on it through the ordinary checkout path.
// Splitting it this way keeps the create itself on the bundled CLI.
// Only the ref resolution is PR-aware. The branch survives a failed
// create, which is fine: it's the same branch `gh pr checkout` would
// have left, and a retry reuses it.
export function useCreateWorktreeFromPullRequest() {
  const queryClient = useQueryClient();
  const registry = useRegistry();
  const { api, deviceId, keys } = useHostScope();
  return useMutation<
    CreateWorktreeResult,
    Error,
    CreateWorktreeFromPullRequestInput
  >({
    mutationFn: async ({ projectId, worktreeName, number, cloneFiles }) => {
      const { branch } = await api.githubCli.resolvePullRequestCheckout({
        projectId,
        number,
      });
      return api.worktrees.create({
        projectId,
        worktreeName,
        base: branch,
        checkout: true,
        cloneFiles,
      });
    },
    onSuccess: (result, vars) => {
      spliceWorktreeRow(registry, deviceId, result.worktree);
      // The resolve step created a local branch, so the branch list and
      // the "already checked out" bookkeeping behind it are both stale.
      void queryClient.invalidateQueries({
        queryKey: keys.branches(vars.projectId),
      });
    },
    meta: { errorTitle: "Couldn't check out pull request" },
  });
}

interface ConvertExternalWorktreeInput {
  projectId: string;
  worktreeId: string;
  force: boolean;
}

// Convert and relocate both leave the worktree under a new id: swap
// the row in the list and drop the script runs cached under the old id.
function useReplaceWorktree<
  Input extends { projectId: string; worktreeId: string },
  Result,
>(
  call: (api: HostApi, input: Input) => Promise<Result>,
  rowOf: (result: Result) => Worktree,
  // The page surfaces per-row errors inline; a toast on top would be noise.
  meta: Record<string, unknown> = { silentError: true },
) {
  const registry = useRegistry();
  const { api, deviceId } = useHostScope();
  const scriptRuns = useScriptRuns();
  return useMutation<Result, Error, Input>({
    mutationFn: (input) => call(api, input),
    onSuccess: (result, vars) => {
      spliceWorktreeRow(registry, deviceId, rowOf(result), vars.worktreeId);
      scriptRuns.clearForWorktree(vars.worktreeId);
    },
    meta,
  });
}

// The old external worktree's id no longer maps to anything on disk.
// Drop any cached script runs so they don't linger in the UI.
export function useConvertExternalWorktree() {
  return useReplaceWorktree<ConvertExternalWorktreeInput, CreateWorktreeResult>(
    (api, input) => api.worktrees.convertExternal(input),
    (result) => result.worktree,
  );
}

interface RelocateWorktreeInput {
  projectId: string;
  worktreeId: string;
  destinationPath: string;
}

// The relocated worktree's id changes (it's derived from path), so
// any cached script runs keyed by the pre-move id are stranded.
export function useRelocateWorktree() {
  return useReplaceWorktree<RelocateWorktreeInput, Worktree>(
    (api, input) => api.worktrees.relocate(input),
    (worktree) => worktree,
  );
}

interface RenameWorktreeInput {
  projectId: string;
  worktreeId: string;
  name: string;
}

// A rename is a move to a new folder name, so the id changes as a
// relocate's does.
export function useRenameWorktree() {
  return useReplaceWorktree<RenameWorktreeInput, Worktree>(
    (api, input) => api.worktrees.rename(input),
    (worktree) => worktree,
    { errorTitle: "Couldn't rename worktree" },
  );
}

interface DeleteWorktreeInput {
  projectId: string;
  worktreeId: string;
  force?: boolean;
  skipCleanup?: boolean;
}

// Scoped by device: worktree ids are content hashes of the absolute
// path, so the same username and layout on two of the owner's machines
// yields colliding ids. An unscoped key would let a remote delete flip
// the local sidebar row of the same-named local worktree into its
// deleting state.
const deleteWorktreeMutationKey = (deviceId: string) =>
  ["delete-worktree", deviceId] as const;

// A single delete names its worktree. A stack removal names the
// worktrees it takes on the device the key is for.
type DeleteVariables = { worktreeId?: string; worktreeIds?: readonly string[] };

const deleteFilters = (deviceId: string, worktreeId: string) => ({
  mutationKey: deleteWorktreeMutationKey(deviceId),
  predicate: (m: { state: { variables: unknown } }) => {
    const variables = m.state.variables as DeleteVariables | undefined;
    return (
      variables?.worktreeId === worktreeId ||
      (variables?.worktreeIds?.includes(worktreeId) ?? false)
    );
  },
});

// Whether this window's own delete of the worktree is in flight. The
// host announces that delete's removal too, and the announcement lands
// before the invoke replies. The mutation's own success path forgets
// the row and routes off it in one go, so the follower leaves the
// row to it.
export function isOwnDeletePending(
  queryClient: QueryClient,
  deviceId: string,
  worktreeId: string,
): boolean {
  return queryClient.isMutating(deleteFilters(deviceId, worktreeId)) > 0;
}

// What the renderer does once a worktree is gone from a device: drop
// it from its list at once (consumers routing off the back of the
// mutation must not read it until the host's list drops it too), clear
// its script runs, and remove its no-longer-observed queries so nothing
// can refetch or replay them. Run by this window's own delete on
// success, by a mirror stop, and for every removal a host announces
// (boot's worktrees:removal follower), whoever asked for it.
export function forgetDeletedWorktree(
  queryClient: QueryClient,
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  projectId: string,
  worktreeId: string,
): void {
  forgetDeletedWorktrees(queryClient, registry, deviceId, projectId, [
    worktreeId,
  ]);
}

// Several at once (a stack's layers): one list edit for all of them.
function forgetDeletedWorktrees(
  queryClient: QueryClient,
  registry: AtomRegistry.AtomRegistry,
  deviceId: string,
  projectId: string,
  worktreeIds: readonly string[],
): void {
  if (worktreeIds.length === 0) return;
  forgetWorktreeRows(registry, deviceId, projectId, worktreeIds);
  for (const worktreeId of worktreeIds) {
    scriptRunsFor(deviceId).clearForWorktree(worktreeId);
    // Same treatment as project removal. Active queries (the detail
    // route unmounts only after the post-delete navigation) are left
    // to go inactive and gc naturally.
    queryClient.removeQueries({
      type: "inactive",
      predicate: worktreeQueriesOn(deviceId, worktreeId),
    });
  }
}

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  const registry = useRegistry();
  const { api, deviceId } = useHostScope();
  return useMutation<DeleteWorktreeResult, Error, DeleteWorktreeInput>({
    mutationKey: deleteWorktreeMutationKey(deviceId),
    mutationFn: (input) => api.worktrees.delete(input),
    onMutate: async (vars) => {
      // Cancel this worktree's in-flight fetches (a focus-triggered
      // diff/data refetch) before main starts removing it: left to
      // settle, they'd reject with "Unknown worktree" and toast, while
      // cancellation is swallowed silently. Gated on the scoped device
      // so another device's queries never match on a coincidentally
      // equal worktree id.
      await queryClient.cancelQueries({
        predicate: worktreeQueriesOn(deviceId, vars.worktreeId),
      });
    },
    onSuccess: (data, vars) => {
      // Only when the worktree was actually removed. Cleanup failures
      // keep the worktree around for retry.
      if (data.ok) {
        forgetDeletedWorktree(
          queryClient,
          registry,
          deviceId,
          vars.projectId,
          vars.worktreeId,
        );
      }
    },
    // The detail page swaps into a force-delete prompt on failure, so a
    // toast on top would be noise.
    meta: { silentError: true },
  });
}

// The merged layers' worktrees of a stack, removed on every device
// holding one at once: each device's host removes its own (it runs
// `sm rm --stack`), and its rows here are forgotten the way a single
// delete's are. The devices are asked together and the outcome is
// per device, so a refusal on one (a dirty worktree there) never
// hides what the others did. The caller decides what to show, since
// the page may have moved on by the time everything answers. Keyed
// and named like a single delete of the page's device's worktrees,
// so the host's removal broadcast for them is left to this mutation
// (isOwnDeletePending), which forgets the rows and routes off the
// page in one go.

export interface StackCleanupOutcome {
  // By device id: the worktree ids that went.
  removed: Map<string, readonly string[]>;
  failures: StackCleanupFailure[];
}

export interface StackCleanupInput {
  devices: readonly ReadyStackCleanupDevice[];
  // The page's device's worktrees among them, for the delete filters.
  worktreeIds: readonly string[];
  force?: boolean;
  skipCleanup?: boolean;
}

export function useDeleteStackWorktrees() {
  const queryClient = useQueryClient();
  const registry = useRegistry();
  const { deviceId } = useHostScope();
  return useMutation<StackCleanupOutcome, Error, StackCleanupInput>({
    mutationKey: deleteWorktreeMutationKey(deviceId),
    mutationFn: async ({ devices, force, skipCleanup }) => {
      const outcome: StackCleanupOutcome = { removed: new Map(), failures: [] };
      await Promise.all(
        devices.map(async (device) => {
          try {
            const result = await device.api.worktrees.deleteStack({
              projectId: device.projectId,
              worktreeId: device.target.id,
              force,
              skipCleanup,
            });
            outcome.removed.set(device.deviceId, result.removed);
            forgetDeletedWorktrees(
              queryClient,
              registry,
              device.deviceId,
              device.projectId,
              result.removed,
            );
            if (!result.ok) {
              outcome.failures.push({
                label: device.label,
                message: "a cleanup script failed, so a worktree stayed",
                kind: "cleanup",
              });
            }
          } catch (error) {
            outcome.failures.push({
              label: device.label,
              message: errorMessageOf(error),
              kind: isCommandRefusedError(error) ? "refused" : "error",
            });
          }
        }),
      );
      return outcome;
    },
    meta: { silentError: true },
  });
}

// Whether the worktree is on its way out: this window's own delete of
// it is in flight, or its device announced it is removing it (every
// delete broadcasts its removal, whoever asked for it: a mirror stop,
// a transplant's teardown, a CLI unmirror, another window). The list
// drops the row only once the delete resolves, so without the
// announcement a worktree being removed by anything but this window's
// delete button reads as an ordinary one for the seconds its cleanup
// takes. `deviceId` names the peer a remote sidebar row belongs to;
// absent, it is the surrounding scope's device (this machine with no
// provider).
export function useIsDeletingWorktree(
  worktreeId: string,
  deviceId?: string,
): boolean {
  const scope = useHostScope();
  const onDevice = deviceId ?? scope.deviceId;
  const removing = useWorktreeRemoving(worktreeId, onDevice);
  return useIsMutating(deleteFilters(onDevice, worktreeId)) > 0 || removing;
}

// The per-worktree row changes (shelf, auto-pull, idle agents) share
// one shape: the row shows the change while the call runs, then the row
// the host answered with until its list next streams, and as it was if
// the call failed (changeWorktreeRow). Such a change edits a row and
// never adds or drops one.
type WorktreeVars = { projectId: string; worktreeId: string };
type AgentSessionVars = WorktreeVars & { harness: string; session: string };

function useWorktreeRowMutation<V extends WorktreeVars>(
  call: (api: HostApi, input: V) => Promise<Worktree>,
  patch: (worktree: Worktree, input: V) => Worktree,
  errorTitle: string,
  onSettled?: (api: HostApi, input: V) => void,
) {
  const registry = useRegistry();
  const { api, deviceId } = useHostScope();
  return useMutation<Worktree, Error, V>({
    mutationFn: async (input) => {
      const change = changeWorktreeRow(
        registry,
        deviceId,
        input.projectId,
        input.worktreeId,
        (w) => patch(w, input),
      );
      try {
        const worktree = await call(api, input);
        change.answered(worktree);
        return worktree;
      } catch (error) {
        change.failed();
        throw error;
      }
    },
    onSuccess: (_data, vars) => onSettled?.(api, vars),
    meta: { errorTitle },
  });
}

export function useSetShelved() {
  return useWorktreeRowMutation(
    (api, input: WorktreeVars & { shelved: boolean }) =>
      api.worktrees.setShelved(input),
    (w, { shelved }) => ({ ...w, shelved }),
    "Couldn't update shelved state",
  );
}

// Every agent session bound to a worktree goes idle, for a turn whose
// end no hook reported.
export function useIdleAgents() {
  return useWorktreeRowMutation(
    (api, input: WorktreeVars) => api.worktrees.idleAgents(input),
    (w) => ({
      ...w,
      agentWorking: false,
      agentSessions: w.agentSessions?.map((s) => ({
        ...s,
        state: "idle" as const,
      })),
    }),
    "Couldn't mark the agents idle",
  );
}

export function useUnbindAgent() {
  return useWorktreeRowMutation(
    (api, input: AgentSessionVars) => api.worktrees.unbindAgent(input),
    (w, { harness, session }) => {
      const agentSessions = (w.agentSessions ?? []).filter(
        (s) => s.harness !== harness || s.session !== session,
      );
      return {
        ...w,
        agentSessions,
        agentWorking: agentSessions.some((s) => s.state === "working"),
      };
    },
    "Couldn't unbind the agent session",
  );
}

export function useResumeAgent() {
  const { api } = useHostScope();
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- by design: resuming opens a terminal and leaves the session's binding as it was
  return useMutation<void, Error, AgentSessionVars>({
    mutationFn: (input) => api.worktrees.resumeAgent(input),
    meta: { errorTitle: "Couldn't resume the agent session" },
  });
}

// Marking a worktree is followed by a project refresh: its auto-pull
// pass fast-forwards the newly marked worktree right away when it
// qualifies (instead of on the minute sweep), and announces the change
// to every row and viewer the way any pull does. Fire and forget: the
// mark itself already landed, and the fetch path reports its own
// failures.
export function useSetAutoPull() {
  return useWorktreeRowMutation(
    (api, input: WorktreeVars & { autoPull: boolean }) =>
      api.worktrees.setAutoPull(input),
    (w, { autoPull }) => ({ ...w, autoPull }),
    "Couldn't update auto-pull",
    (api, input) => {
      if (input.autoPull)
        void api.git.refreshProject({ projectId: input.projectId });
    },
  );
}
