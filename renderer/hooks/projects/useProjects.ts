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
import { hostKeysFor, queryKeys } from "@/lib/queryKeys";

// The slice of the host api the projects list calls. window.api and a
// remote device's api both satisfy it, so one options builder serves the
// local sidebar and the read-only remote forest without a parallel fork.
type ProjectListApi = {
  projects: { list: () => Promise<Project[]> };
};

// Which device's projects to read, and over which api. Both default to
// the local machine, so the local call site below stays byte-identical:
// the key is hostKeysFor(localDeviceId) and the queryFn hits window.api.
export interface ProjectsScope {
  deviceId?: string;
  api?: ProjectListApi | undefined;
}

// Single source of truth for the projects-list query, keyed under the
// scoped device so a remote caller can read a peer's projects into their
// own cache slot under the same key shape.
export function projectsQueryOptions({
  deviceId = window.api.deviceId,
  api = window.api,
}: ProjectsScope = {}) {
  return queryOptions<Project[]>({
    queryKey: hostKeysFor(deviceId)("projects"),
    queryFn: () => (api ? api.projects.list() : []),
    // Local: api and id are always present, so this stays always-enabled.
    // Remote: an unconnected device never fetches.
    enabled: api !== undefined && deviceId !== "",
    meta: { errorTitle: "Couldn't load projects" },
  });
}

export function useProjects() {
  return useQuery(projectsQueryOptions());
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
  return useMutation<Project, Error, string>({
    mutationFn: (path) => window.api.projects.add(path),
    // Returned (not void-ed) so mutateAsync resolves only after the
    // projects list is fresh: callers navigate into the new project right
    // away, and routes render "not found" against a stale list.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    meta: { errorTitle: "Couldn't add project" },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation<void, Error, string>({
    mutationFn: (id) => window.api.projects.remove(id),
    onMutate: async (id) => {
      // Cancel this project's in-flight fetches before main starts the
      // removal (mirrors the nuke path): left to settle, one would
      // reject with "Unknown project" during the awaits below and
      // toast, while cancellation is swallowed silently.
      await queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(id),
      });
    },
    onSuccess: async (_data, id) => {
      // Leave any route under the removed project before touching the
      // cache: its mounted queries (config, branches, diff, worktree
      // state, ...) would otherwise refetch against the unregistered id
      // on the next focus and each toast an "Unknown project" error.
      const { pathname } = router.state.location;
      if (pathname.startsWith(`/projects/${id}`)) {
        await router.navigate({ to: "/" });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      // With the route and sidebar row gone nothing observes the
      // removed project's queries; drop the leftovers so nothing can
      // replay them. Only inactive ones -- removing a query that still
      // has an observer (a row mid-unmount) would refetch it instead.
      queryClient.removeQueries({
        type: "inactive",
        predicate: (query) => query.queryKey.includes(id),
      });
    },
    meta: { errorTitle: "Couldn't remove project" },
  });
}

export function useReorderProjects() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { draggedId: string; targetId: string; position: "before" | "after" },
    { previous?: Project[] }
  >({
    mutationFn: (input) => window.api.projects.reorder(input),
    onMutate: ({ draggedId, targetId, position }) => {
      // Synchronous on purpose: dnd-kit reads the active item's rect for
      // the drop animation right after onDragEnd returns. If the optimistic
      // reorder is awaited, React hasn't flushed by then and the overlay
      // animates back to the old slot before snapping. Cancel without
      // awaiting; cancelled in-flight fetches can't overwrite the cache.
      void queryClient.cancelQueries({ queryKey: queryKeys.projects() });
      const previous = queryClient.getQueryData<Project[]>(
        queryKeys.projects(),
      );
      queryClient.setQueryData<Project[]>(queryKeys.projects(), (current) =>
        current
          ? reorderProjects(current, draggedId, targetId, position)
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(queryKeys.projects(), context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    meta: { errorTitle: "Couldn't reorder projects" },
  });
}
