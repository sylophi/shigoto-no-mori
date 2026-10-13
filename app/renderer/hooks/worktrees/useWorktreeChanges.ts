import {
  focusManager,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ChangedFile,
  CommitChangesResult,
  CommitPicks,
  FileHunks,
  CommitMessage,
  DiscardChangesResult,
  LineChange,
  ResetSoftResult,
  Worktree,
} from "@shigomori/contracts/schemas";
import { callOf } from "@shigomori/contracts/contract";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type * as Effect from "effect/Effect";
import { useEffect } from "react";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AsyncResultValue from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  useHostScope,
  type HostApi,
  type HostScope,
} from "@/hooks/remote/useHostScope";
import { clearCommitDraft } from "@/lib/commitDraft";
import {
  type LiveViewState,
  useRegistry,
  useView,
  useViewErrorToast,
} from "@/lib/runtime/viewHooks";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { writeBackWorktree } from "@/hooks/worktrees/useWorktrees";
import type { QueryKeyRegistry } from "@/lib/queryKeys";

// The changes page's views of a worktree.
type TreeView =
  | "watchChangeStatus"
  | "watchFileDiff"
  | "watchFileHunks"
  | "watchOperation";

// One of the changes page's views of a worktree, keyed by the device
// and the view's input.
const treeViewAtom = Atom.family((key: string) => {
  const { deviceId, view, input } = JSON.parse(key) as {
    deviceId: string;
    view: TreeView;
    input: never;
  };
  return hostViewAtom({
    deviceId,
    view: callOf(worktreesContract, view),
    input,
    // A file's diff and hunks stop streaming soon after the page moves
    // to another file, so a long review leaves no reads behind.
    ...(view === "watchFileDiff" || view === "watchFileHunks"
      ? { idle: "5 seconds" }
      : {}),
  });
});

// The view `view` of the scoped device's worktree, `input` its payload
// (null while there is nothing to read), its failure a toast titled
// `failed`.
export function useTreeView<A>(
  view: TreeView,
  input: object | null,
  failed: string,
): LiveViewState<A> {
  const { deviceId, hasHost } = useHostScope();
  const registry = useRegistry();
  const atom =
    hasHost && input !== null
      ? (treeViewAtom(JSON.stringify({ deviceId, view, input })) as Atom.Atom<
          AsyncResult.AsyncResult<A, unknown>
        >)
      : null;
  const state = useView(atom);
  useViewErrorToast(state, failed);
  // A view whose reads kept failing ends: the window coming back asks
  // again, as a query's focus refetch did, once however many readers
  // the view has.
  const ended = state.error !== null;
  useEffect(
    () =>
      ended && atom !== null
        ? focusManager.subscribe((focused) => {
            if (focused && AsyncResultValue.isFailure(registry.get(atom))) {
              registry.refresh(atom);
            }
          })
        : undefined,
    [ended, atom, registry],
  );
  return state;
}

// Every changed file: what it is, how much of it is staged, and its
// +/- counts. The changes page draws its whole list from this and
// fetches a diff only for the picked file. It is the host's view
// (worktrees:watchChangeStatus), read again as the worktree's files or
// its git move and every few seconds for an edit no watch saw.
export function useWorktreeChanges(projectId: string, worktreeId: string) {
  return useTreeView<readonly ChangedFile[]>(
    "watchChangeStatus",
    { projectId, worktreeId },
    "Couldn't read change status",
  );
}

// The list read once, for a preview (the transplant review's file
// list) that crosses the device link and need not follow the tree.
export function useWorktreeChangesOnce(projectId: string, worktreeId: string) {
  const { api, keys } = useHostScope();
  return useQuery<readonly ChangedFile[]>({
    queryKey: keys.worktreeChanges(projectId, worktreeId),
    queryFn: ({ signal }) =>
      api.run(api.worktrees.changeStatus({ projectId, worktreeId }), {
        signal,
      }),
    refetchOnWindowFocus: false,
    staleTime: 0,
    meta: { errorTitle: "Couldn't read change status" },
  });
}

// The changes page's views read now, after a change this window made,
// so the page shows it without waiting for the worktree's watch.
function refreshChanges(
  api: HostApi,
  scope: { projectId: string; worktreeId: string },
): void {
  void api.run(api.worktrees.refreshChangeStatus(scope)).catch(() => undefined);
}

// One modified file's hunks, to tick one at a time. Off for anything
// else (an untracked, deleted, renamed or conflicted file),
// which only ticks whole.
export function useFileHunks(
  projectId: string,
  worktreeId: string,
  path: string | undefined,
) {
  return useTreeView<FileHunks>(
    "watchFileHunks",
    path === undefined ? null : { projectId, worktreeId, path },
    "Couldn't read the file's hunks",
  );
}

export function useDiscardHunks() {
  return useWorkingTreeMutation<
    {
      projectId: string;
      worktreeId: string;
      path: string;
      changes: LineChange[];
    },
    DiscardChangesResult
  >(
    (api, input) => api.worktrees.discardHunks(input),
    (data) => data.worktree,
    "Couldn't discard the change",
  );
}

// The working tree moved by a call this window made: the changes
// page's views read now, and the transplant preview's list asked again.
export function refreshTree(
  queryClient: ReturnType<typeof useQueryClient>,
  { api, keys }: { api: HostApi; keys: QueryKeyRegistry },
  scope: { projectId: string; worktreeId: string },
): void {
  void queryClient.invalidateQueries({
    queryKey: keys.worktreeChanges(scope.projectId, scope.worktreeId),
  });
  refreshChanges(api, scope);
}

// That, and the worktree the call answered with written back into its
// list, for the sidebar's count and recent commits.
export function useWorkingTreeWriteBack() {
  const queryClient = useQueryClient();
  const registry = useRegistry();
  const { api, deviceId, keys } = useHostScope();
  return (
    scope: { projectId: string; worktreeId: string },
    worktree: Worktree,
  ): void => {
    writeBackWorktree(registry, deviceId, worktree);
    refreshTree(queryClient, { api, keys }, scope);
  };
}

// Discard, restore and undo share one shape: call the api, then write
// back the worktree the call answers with and refresh the working tree.
export function useWorkingTreeMutation<
  Input extends { projectId: string; worktreeId: string },
  Result,
>(
  call: (api: HostApi, input: Input) => Effect.Effect<Result, unknown>,
  worktreeOf: (result: Result) => Worktree,
  errorTitle: string,
) {
  const { api } = useHostScope();
  const writeBack = useWorkingTreeWriteBack();
  return useMutation<Result, Error, Input>({
    mutationFn: (input) => api.run(call(api, input)),
    onSuccess: (data, vars) => writeBack(vars, worktreeOf(data)),
    meta: { errorTitle },
  });
}

interface CommitInput extends CommitPicks {
  projectId: string;
  worktreeId: string;
  // Absent for an amend that keeps HEAD's message.
  summary?: string;
  description?: string;
  amend?: boolean;
}

export function useCommitChanges() {
  const { api } = useHostScope();
  const writeBack = useWorkingTreeWriteBack();
  return useMutation<CommitChangesResult, Error, CommitInput>({
    mutationFn: (input) => api.run(api.worktrees.commit(input)),
    onSuccess: (data, vars) => {
      // The page empties its own draft state. This covers the stored
      // copy when the page was left before the commit landed. A commit
      // that kept HEAD's message never used the draft.
      if (vars.summary !== undefined) {
        clearCommitDraft(vars.projectId, vars.worktreeId);
      }
      writeBack(vars, data.worktree);
    },
    // The index is set to the picks before git can refuse (a hook, no
    // identity), and the status says what is in it, so it is re-read.
    onError: (_err, vars) => refreshChanges(api, vars),
    // The composer shows the failure (hook output, identity errors) in
    // place, where it can be read and selected. A toast would truncate it.
    meta: { silentError: true },
  });
}

interface DiscardInput {
  projectId: string;
  worktreeId: string;
  paths: string[];
}

export function useDiscardChanges() {
  return useWorkingTreeMutation<DiscardInput, DiscardChangesResult>(
    (api, input) => api.worktrees.discardChanges(input),
    (data) => data.worktree,
    "Couldn't discard changes",
  );
}

interface RestoreDiscardInput {
  projectId: string;
  worktreeId: string;
  snapshot: string;
}

export function useRestoreDiscard() {
  return useWorkingTreeMutation<RestoreDiscardInput, Worktree>(
    (api, input) => api.worktrees.restoreDiscard(input),
    (worktree) => worktree,
    "Couldn't restore the discarded changes",
  );
}

// The message of one commit, for prefilling an amend. Immutable per
// hash, like the commit diff. Exposed as options so the caller can add
// its own `enabled`. Not a hook, so the scope (which device's api and
// keys) comes in from the caller.
export function commitMessageQueryOptions(
  { api, keys }: Pick<HostScope, "api" | "keys">,
  projectId: string,
  worktreeId: string,
  hash: string,
) {
  return queryOptions<CommitMessage>({
    queryKey: keys.commitMessage(projectId, worktreeId, hash),
    queryFn: ({ signal }) =>
      api.run(api.worktrees.commitMessage({ projectId, worktreeId, hash }), {
        signal,
      }),
    staleTime: Infinity,
    meta: { errorTitle: "Couldn't read the last commit's message" },
  });
}

interface ResetSoftInput {
  projectId: string;
  worktreeId: string;
  target: string;
  expectHead?: string;
}

// Undo (and redo) of commits. Both end in the same place: HEAD moved,
// index and working tree as they were, so the same refresh covers it.
export function useResetSoft() {
  return useWorkingTreeMutation<ResetSoftInput, ResetSoftResult>(
    (api, input) => api.worktrees.resetSoft(input),
    (data) => data.worktree,
    "Couldn't undo the commit",
  );
}
