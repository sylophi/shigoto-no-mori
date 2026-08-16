import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ForestSort } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// Resolved, not the raw query: main already defaults a missing or
// unreadable preference to "activity", so the only gap left is the first
// paint before the read lands. Applying the same default here keeps that
// one literal in one place instead of at each call site.
export function useForestSort(): ForestSort {
  const { data } = useQuery<ForestSort>({
    queryKey: queryKeys.forestSort(),
    queryFn: () => window.api.projects.getForestSort(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { errorTitle: "Couldn't read the forest sort" },
  });
  return data ?? "activity";
}

interface SortMutationContext {
  previous?: ForestSort;
}

// Optimistic like the sidebar layout: the whole forest reorders on this
// value, so waiting a round trip to redraw would read as a hang.
export function useSetForestSort() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, ForestSort, SortMutationContext>({
    mutationFn: (sort) => window.api.projects.setForestSort(sort),
    onMutate: async (sort) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.forestSort() });
      const previous = queryClient.getQueryData<ForestSort>(
        queryKeys.forestSort(),
      );
      queryClient.setQueryData(queryKeys.forestSort(), sort);
      return { previous };
    },
    onError: (_err, _sort, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.forestSort(), ctx.previous);
      }
    },
    meta: { errorTitle: "Couldn't save the forest sort" },
  });
}
