import {
  queryOptions,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type {
  CloneProjectPayload,
  Project,
} from "@shigomori/contracts/schemas";
import { reorderProjects } from "@shared/reorder";
import {
  hostKeyDeviceId,
  queryKeysFor,
  worktreeQueriesOn,
} from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  resolveForestScope,
  type HostForestScope,
} from "@/hooks/worktrees/useWorktrees";

// Single source of truth for the projects-list query. The key registry
// is derived from the scope's device id, so the key and the queryFn can
// never name different devices. The scope rule is resolveForestScope's.
export function projectsQueryOptions(
  scope: HostForestScope = {},
  enabled = true,
) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<readonly Project[]>({
    queryKey: queryKeysFor(deviceId).projects(),
    queryFn: () => (api ? api.projects.list() : []),
    // Local: api and id are always present, so this stays always-enabled.
    // Remote: an unconnected device never fetches. A caller with no use
    // for the list yet holds it off.
    enabled: enabled && api !== undefined && deviceId !== "",
    meta: { errorTitle: "Couldn't load projects" },
  });
}

export function useProjects() {
  const scope = useHostScope();
  return useQuery(projectsQueryOptions(scope));
}

export function useAddProject() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<Project, Error, string>({
    mutationFn: (path) => api.projects.add({ path }),
    // Returned (not void-ed) so mutateAsync resolves only after the
    // projects list is fresh: callers navigate into the new project right
    // away, and routes render "not found" against a stale list.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.projects() }),
    meta: { errorTitle: "Couldn't add project" },
  });
}

// Clones a remote onto the scoped device and registers the checkout.
// The clone runs there, under that device's git credentials.
export function useCloneProject() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<Project, Error, CloneProjectPayload>({
    mutationFn: (input) => api.projects.clone(input),
    // Returned for the same reason useAddProject returns it.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.projects() }),
    meta: { errorTitle: "Couldn't clone the repository" },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { api, deviceId, keys } = useHostScope();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.projects.remove({ id }),
    onMutate: async (id) => {
      // Cancel this project's in-flight fetches before main starts the
      // removal (mirrors the nuke path): left to settle, one would
      // reject with "Unknown project" during the awaits below and
      // toast, while cancellation is swallowed silently. Gated on the
      // scoped device so another device's queries never match on a
      // coincidentally equal project id.
      await queryClient.cancelQueries({
        predicate: (query) =>
          hostKeyDeviceId(query.queryKey) === deviceId &&
          query.queryKey.includes(id),
      });
    },
    onSuccess: async (_data, id) => {
      // Leave any route under the removed project before touching the
      // cache: its mounted queries (config, branches, diff, worktree
      // state, ...) would otherwise refetch against the unregistered id
      // on the next focus and each toast an "Unknown project" error.
      // The pages of the device the removal ran on.
      const { pathname } = router.state.location;
      if (pathname.startsWith(`/devices/${deviceId}/projects/${id}`)) {
        await router.navigate({ to: "/" });
      }
      await queryClient.invalidateQueries({
        queryKey: keys.projects(),
      });
      // With the route and sidebar row gone nothing observes the
      // removed project's queries; drop the leftovers so nothing can
      // replay them. Only inactive ones: removing a query that still
      // has an observer (a row mid-unmount) would refetch it instead.
      queryClient.removeQueries({
        type: "inactive",
        predicate: (query) =>
          hostKeyDeviceId(query.queryKey) === deviceId &&
          query.queryKey.includes(id),
      });
    },
    meta: { errorTitle: "Couldn't remove project" },
  });
}

// Points a project at where its repo lives now, after it was moved or
// renamed by hand. The id stays, so the project's own queries refetch
// against the new path along with the list.
export function useRelocateProject(id: string) {
  const queryClient = useQueryClient();
  const { api, deviceId, keys } = useHostScope();
  return useMutation<Project, Error, string>({
    mutationKey: relocateProjectKey(deviceId, id),
    mutationFn: (path) => api.projects.relocate({ id, path }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.projects() }),
        // Any host key naming the id: the one predicate that sweeps a
        // worktree's queries sweeps a project's just as well.
        queryClient.invalidateQueries({
          predicate: worktreeQueriesOn(deviceId, id),
        }),
      ]),
    meta: { errorTitle: "Couldn't locate the project" },
  });
}

// Whether a relocation of the project is running on that device. The
// picker that started it has closed by then, and the project reads as
// missing until the list refetches.
export function useRelocatingProject(deviceId: string, id: string): boolean {
  return useIsMutating({ mutationKey: relocateProjectKey(deviceId, id) }) > 0;
}

const relocateProjectKey = (deviceId: string, id: string) =>
  ["relocateProject", deviceId, id] as const;

export function useReorderProjects() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    void,
    Error,
    { draggedId: string; targetId: string; position: "before" | "after" },
    { previous?: readonly Project[] }
  >({
    mutationFn: (input) => api.projects.reorder(input),
    onMutate: ({ draggedId, targetId, position }) => {
      // Synchronous on purpose: dnd-kit reads the active item's rect for
      // the drop animation right after onDragEnd returns. If the optimistic
      // reorder is awaited, React hasn't flushed by then and the overlay
      // animates back to the old slot before snapping. Cancel without
      // awaiting; cancelled in-flight fetches can't overwrite the cache.
      void queryClient.cancelQueries({
        queryKey: keys.projects(),
      });
      const previous = queryClient.getQueryData<readonly Project[]>(
        keys.projects(),
      );
      queryClient.setQueryData<readonly Project[]>(keys.projects(), (current) =>
        current
          ? reorderProjects(current, draggedId, targetId, position)
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(keys.projects(), context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: keys.projects(),
      });
    },
    meta: { errorTitle: "Couldn't reorder projects" },
  });
}
