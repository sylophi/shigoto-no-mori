import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { Project } from "@shared/schemas";
import { reorderProjects } from "@shared/reorder";
import {
  hostKeyDeviceId,
  localDeviceId,
  queryKeys,
  queryKeysFor,
} from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  resolveForestScope,
  type HostForestScope,
} from "@/hooks/worktrees/useWorktrees";

// Single source of truth for the projects-list query. The key registry
// is derived from the scope's device id, so the key and the queryFn can
// never name different devices. The scope rule is resolveForestScope's.
export function projectsQueryOptions(scope: HostForestScope = {}) {
  const { deviceId, api } = resolveForestScope(scope);
  return queryOptions<Project[]>({
    queryKey: queryKeysFor(deviceId).projects(),
    queryFn: () => (api ? api.projects.list() : []),
    // Local: api and id are always present, so this stays always-enabled.
    // Remote: an unconnected device never fetches.
    enabled: api !== undefined && deviceId !== "",
    meta: { errorTitle: "Couldn't load projects" },
  });
}

export function useProjects() {
  const scope = useHostScope();
  return useQuery(projectsQueryOptions(scope));
}

// Refetch the projects list whenever main records a project action, so the
// usage-sorted sidebar ("most used" / "most recently used") reorders live.
// Call once at the App root; the subscriber owns its lifecycle.
export function useWatchProjectUsage(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.projects.onUsageBumped(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      }),
    [queryClient],
  );
}

export function useAddProject() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<Project, Error, string>({
    mutationFn: (path) => api.projects.add(path),
    // Returned (not void-ed) so mutateAsync resolves only after the
    // projects list is fresh: callers navigate into the new project right
    // away, and routes render "not found" against a stale list.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.projects() }),
    meta: { errorTitle: "Couldn't add project" },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { api, deviceId, keys } = useHostScope();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.projects.remove(id),
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
      // Either tree: the local one, or the device twin when the
      // removal ran on a peer.
      const { pathname } = router.state.location;
      const prefix =
        deviceId === localDeviceId
          ? `/projects/${id}`
          : `/devices/${deviceId}/projects/${id}`;
      if (pathname.startsWith(prefix)) {
        await router.navigate({ to: "/" });
      }
      await queryClient.invalidateQueries({
        queryKey: keys.projects(),
      });
      // With the route and sidebar row gone nothing observes the
      // removed project's queries; drop the leftovers so nothing can
      // replay them. Only inactive ones -- removing a query that still
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

export function useReorderProjects() {
  const queryClient = useQueryClient();
  const { api, keys } = useHostScope();
  return useMutation<
    void,
    Error,
    { draggedId: string; targetId: string; position: "before" | "after" },
    { previous?: Project[] }
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
      const previous = queryClient.getQueryData<Project[]>(keys.projects());
      queryClient.setQueryData<Project[]>(keys.projects(), (current) =>
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
