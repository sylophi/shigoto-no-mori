import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SidebarView } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Resolved, not the raw query: main already defaults a missing or
// unreadable preference to "projects", so the only gap left is the first
// paint before the read lands. Applying the same default here keeps that
// one literal in one place instead of at each call site.
export function useSidebarView(): SidebarView {
  const { data } = useQuery<SidebarView>({
    queryKey: queryKeys.sidebarView(),
    queryFn: () => window.api.projects.getSidebarView(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read the sidebar layout" },
  });
  return data ?? "projects";
}

interface ViewMutationContext {
  previous?: SidebarView;
}

// Optimistic like the sort preference: the whole sidebar re-lays-out on
// this value, so waiting a round trip to redraw would read as a hang.
export function useSetSidebarView() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, SidebarView, ViewMutationContext>({
    mutationFn: (view) => window.api.projects.setSidebarView(view),
    onMutate: async (view) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.sidebarView() });
      const previous = queryClient.getQueryData<SidebarView>(
        queryKeys.sidebarView(),
      );
      queryClient.setQueryData(queryKeys.sidebarView(), view);
      return { previous };
    },
    onError: (_err, _view, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.sidebarView(), ctx.previous);
      }
    },
    meta: { errorTitle: "Couldn't save the sidebar layout" },
  });
}
