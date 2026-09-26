import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreateWorktreeResult,
  DeleteWorktreeResult,
  Worktree,
} from "@shared/schemas";
import {
  type QueryKeyRegistry,
  worktreeQueriesOn,
  queryKeysFor,
} from "@/lib/queryKeys";
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

// Splice a new or re-keyed worktree into its cached list (in place of
// `replacesId`, the id it had before a convert or move), then refetch.
// The callers route onto the row's page as soon as the mutation
// resolves, and a list refetch (one `sm worktrees list` run) lands well
// after that, so without the splice the page reads the stale list and
// says "Worktree not found." until it does. The counterpart of
// forgetDeletedWorktree.
function spliceWorktree(
  queryClient: QueryClient,
  keys: QueryKeyRegistry,
  worktree: Worktree,
  replacesId?: string,
): void {
  const key = keys.worktrees(worktree.projectId);
  queryClient.setQueryData<Worktree[]>(key, (current) => {
    if (!current) return current;
    // In place, so the sidebar row and the sibling order don't shift.
    const at = current.findIndex(
      (w) => w.id === worktree.id || w.id === replacesId,
    );
    return at === -1 ? [...current, worktree] : current.with(at, worktree);
  });
  void queryClient.invalidateQueries({ queryKey: key });
}

export function useCreateWorktree() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<CreateWorktreeResult, Error, CreateWorktreeInput>({
    mutationFn: (input) => api.worktrees.create(input),
    onSuccess: (result) => {
      spliceWorktree(queryClient, keys, result.worktree);
    },
    meta: { errorTitle: "Couldn't create worktree" },
  });
}

interface CreateWorktreeFromPullRequestInput {
  projectId: string;
  worktreeName?: string;
  number: number;
}

// Two calls behind one mutation: land the PR head on a local branch,
// then create the worktree on it through the ordinary checkout path.
// Splitting it this way keeps the create itself on the bundled CLI.
// Only the ref resolution is PR-aware. The branch survives a failed
// create, which is fine: it's the same branch `gh pr checkout` would
// have left, and a retry reuses it.
export function useCreateWorktreeFromPullRequest() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    CreateWorktreeResult,
    Error,
    CreateWorktreeFromPullRequestInput
  >({
    mutationFn: async ({ projectId, worktreeName, number }) => {
      const { branch } = await api.githubCli.resolvePullRequestCheckout({
        projectId,
        number,
      });
      return api.worktrees.create({
        projectId,
        worktreeName,
        base: branch,
        checkout: true,
      });
    },
    onSuccess: (result, vars) => {
      spliceWorktree(queryClient, keys, result.worktree);
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
}

// Convert and relocate both leave the worktree under a new id: swap
// the row in the list and drop the script runs cached under the old id.
function useReplaceWorktree<
  Input extends { projectId: string; worktreeId: string },
  Result,
>(
  call: (api: HostApi, input: Input) => Promise<Result>,
  rowOf: (result: Result) => Worktree,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  const scriptRuns = useScriptRuns();
  return useMutation<Result, Error, Input>({
    mutationFn: (input) => call(api, input),
    onSuccess: (result, vars) => {
      spliceWorktree(queryClient, keys, rowOf(result), vars.worktreeId);
      scriptRuns.clearForWorktree(vars.worktreeId);
    },
    // The page surfaces per-row errors inline; a toast on top would be noise.
    meta: { silentError: true },
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

const deleteFilters = (deviceId: string, worktreeId: string) => ({
  mutationKey: deleteWorktreeMutationKey(deviceId),
  predicate: (m: { state: { variables: unknown } }) =>
    (m.state.variables as DeleteWorktreeInput | undefined)?.worktreeId ===
    worktreeId,
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
// it from the cached list synchronously (consumers routing off the
// back of the mutation must not read the stale list during the
// refetch), clear its script runs, and remove its no-longer-observed
// queries so nothing can refetch or replay them. Run by this window's
// own delete on success, by a mirror stop, and for every removal a
// host announces (boot's worktrees:removal follower), whoever asked
// for it.
export function forgetDeletedWorktree(
  queryClient: QueryClient,
  deviceId: string,
  projectId: string,
  worktreeId: string,
): void {
  const keys = queryKeysFor(deviceId);
  queryClient.setQueryData<Worktree[]>(keys.worktrees(projectId), (current) =>
    current ? current.filter((w) => w.id !== worktreeId) : current,
  );
  void queryClient.invalidateQueries({
    queryKey: keys.worktrees(projectId),
  });
  scriptRunsFor(deviceId).clearForWorktree(worktreeId);
  // Same treatment as project removal. Active queries (the detail
  // route unmounts only after the post-delete navigation) are left
  // to go inactive and gc naturally.
  queryClient.removeQueries({
    type: "inactive",
    predicate: worktreeQueriesOn(deviceId, worktreeId),
  });
}

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
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

// The two per-worktree flags (shelf, auto-pull) share one mutation
// shape: an optimistic flip so the row and the sidebar group update
// before the IPC round-trip lands, then a splice of the server's row
// instead of a refetch of the whole project's list (the handler
// already returns the refreshed Worktree, so cache state stays
// accurate without an N-git-call round trip), and a rollback to truth
// on error.
function useSetWorktreeFlag<K extends "shelved" | "autoPull">(
  field: K,
  call: (
    api: HostApi,
    input: { projectId: string; worktreeId: string } & Record<K, boolean>,
  ) => Promise<Worktree>,
  errorTitle: string,
  onSettled?: (
    api: HostApi,
    input: { projectId: string; worktreeId: string } & Record<K, boolean>,
  ) => void,
) {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    Worktree,
    Error,
    { projectId: string; worktreeId: string } & Record<K, boolean>
  >({
    mutationFn: (input) => call(api, input),
    onMutate: (vars) => {
      queryClient.setQueryData<Worktree[]>(
        keys.worktrees(vars.projectId),
        (current) =>
          current
            ? current.map((w) =>
                w.id === vars.worktreeId ? { ...w, [field]: vars[field] } : w,
              )
            : current,
      );
    },
    onSuccess: (data, vars) => {
      queryClient.setQueryData<Worktree[]>(
        keys.worktrees(vars.projectId),
        (current) => current?.map((w) => (w.id === data.id ? data : w)),
      );
      onSettled?.(api, vars);
    },
    onError: (_err, vars) => {
      void queryClient.invalidateQueries({
        queryKey: keys.worktrees(vars.projectId),
      });
    },
    meta: { errorTitle },
  });
}

export function useSetShelved() {
  return useSetWorktreeFlag(
    "shelved",
    (api, input) => api.worktrees.setShelved(input),
    "Couldn't update shelved state",
  );
}

// Marking a worktree is followed by a project refresh: its auto-pull
// pass fast-forwards the newly marked worktree right away when it
// qualifies (instead of on the minute sweep), and announces the change
// to every row and viewer the way any pull does. Fire and forget: the
// mark itself already landed, and the fetch path reports its own
// failures.
export function useSetAutoPull() {
  return useSetWorktreeFlag(
    "autoPull",
    (api, input) => api.worktrees.setAutoPull(input),
    "Couldn't update auto-pull",
    (api, input) => {
      if (input.autoPull) void api.git.refreshProject(input.projectId);
    },
  );
}
