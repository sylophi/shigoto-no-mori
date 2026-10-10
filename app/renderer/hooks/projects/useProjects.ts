import { useAtomSet } from "@effect/atom-react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { callOf } from "@shigomori/contracts/contract";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import type {
  AddProjectPayload,
  CloneProjectPayload,
  CreateProjectPayload,
  Project,
} from "@shigomori/contracts/schemas";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { reorderProjects } from "@shared/reorder";
import {
  hostKeyDeviceId,
  localDeviceId,
  worktreeQueriesOn,
} from "@/lib/queryKeys";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { noteProjects } from "@/lib/viewFeed";
import { hostCallFn, hostViewAtom, optimisticView } from "@/lib/runtime/atoms";
import {
  type LiveViewState,
  useRegistry,
  useView,
  whenViewShows,
} from "@/lib/runtime/viewHooks";

// A device's projects, as its host streams them (projects:watch).
export const projectsAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    localDeviceId,
    view: callOf(projectsContract, "watch"),
    input: undefined,
    onValue: (list) => noteProjects(deviceId, list),
    onStop: () => noteProjects(deviceId, null),
  }),
);

// The list as shown: the stream's, with a reorder still on its way laid
// over it.
const shownProjectsAtom = Atom.family((deviceId: string) =>
  optimisticView(projectsAtom(deviceId)),
);

// A device's projects: the scope's, or another device's by id. Nothing
// is read for a device with no host behind it (a peer without a
// session, the web client's own scope) or while `enabled` holds it off.
export function useDeviceProjects(
  deviceId: string,
  enabled = true,
): LiveViewState<readonly Project[]> {
  return useView(
    enabled && deviceId !== "" ? shownProjectsAtom(deviceId) : null,
  );
}

export function useProjects(): LiveViewState<readonly Project[]> {
  const { deviceId, hasHost } = useHostScope();
  return useDeviceProjects(deviceId, hasHost);
}

// Settles once the device's list has the project, so a caller can move
// into it at once.
function useWhenListed() {
  const registry = useRegistry();
  const { deviceId } = useHostScope();
  return (project: Project) =>
    whenViewShows(registry, projectsAtom(deviceId), (list) =>
      list.some((p) => p.id === project.id),
    ).then(() => project);
}

export function useAddProject() {
  const { api } = useHostScope();
  const whenListed = useWhenListed();
  return useMutation<Project, Error, AddProjectPayload>({
    // Settles once the list has it: callers navigate into the new
    // project right away, and routes render "not found" against a list
    // without it.
    mutationFn: (input) => api.projects.add(input).then(whenListed),
    meta: { errorTitle: "Couldn't add project" },
  });
}

// Clones a remote onto the scoped device and registers the checkout.
// The clone runs there, under that device's git credentials.
export function useCloneProject() {
  const { api } = useHostScope();
  const whenListed = useWhenListed();
  return useMutation<Project, Error, CloneProjectPayload>({
    // Settles once listed, as useAddProject does.
    mutationFn: (input) => api.projects.clone(input).then(whenListed),
    meta: { errorTitle: "Couldn't clone the repository" },
  });
}

// Starts a new repository on the scoped device and registers it.
export function useCreateProject() {
  const { api } = useHostScope();
  const whenListed = useWhenListed();
  return useMutation<Project, Error, CreateProjectPayload>({
    // Settles once listed, as useAddProject does.
    mutationFn: (input) => api.projects.create(input).then(whenListed),
    meta: { errorTitle: "Couldn't create the repository" },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { api, deviceId } = useHostScope();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.projects.remove({ id }),
    onMutate: async (id) => {
      // Cancel this project's in-flight fetches before the host starts the
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
// against the new path, and the list follows as the host streams it.
export function useRelocateProject(id: string) {
  const queryClient = useQueryClient();
  const { api, deviceId } = useHostScope();
  return useMutation<Project, Error, string>({
    mutationKey: relocateProjectKey(deviceId, id),
    mutationFn: (path) => api.projects.relocate({ id, path }),
    // Any host key naming the id: the one predicate that sweeps a
    // worktree's queries sweeps a project's just as well.
    onSuccess: () =>
      queryClient.invalidateQueries({
        predicate: worktreeQueriesOn(deviceId, id),
      }),
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

type ReorderInput = {
  draggedId: string;
  targetId: string;
  position: "before" | "after";
};

// The reorder, laid over the list at once and left to the host's stream
// to settle.
const reorderProjectsAtom = Atom.family((deviceId: string) =>
  Atom.optimisticFn(shownProjectsAtom(deviceId), {
    reducer: (
      current: AsyncResult.AsyncResult<readonly Project[], unknown>,
      { draggedId, targetId, position }: ReorderInput,
    ) =>
      AsyncResult.map(current, (list) =>
        reorderProjects(list, draggedId, targetId, position),
      ),
    fn: hostCallFn({
      deviceId,
      localDeviceId,
      call: (input: ReorderInput) => ({ channel: "projects:reorder", input }),
    }),
  }),
);

export function useReorderProjects() {
  const { deviceId } = useHostScope();
  // Synchronous on purpose: dnd-kit reads the active item's rect for
  // the drop animation right after onDragEnd returns, so the list must
  // already read reordered by then.
  const reorder = useAtomSet(reorderProjectsAtom(deviceId), {
    mode: "promise",
  });
  return useMutation<void, Error, ReorderInput>({
    mutationFn: async (input) => {
      await reorder(input);
    },
    meta: { errorTitle: "Couldn't reorder projects" },
  });
}
