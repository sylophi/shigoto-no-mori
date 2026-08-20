import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";

interface PreferenceContext<T> {
  previous?: T;
}

// One optimistic write for a single-value preference: cancel, snapshot,
// apply, roll back on failure. The cancelQueries is the load-bearing
// part -- it stops an in-flight read clobbering the optimistic value.
export function useOptimisticPreference<T>(
  queryKey: QueryKey,
  write: (value: T) => Promise<void>,
  errorTitle: string,
) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, T, PreferenceContext<T>>({
    mutationFn: write,
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<T>(queryKey);
      queryClient.setQueryData(queryKey, value);
      return { previous };
    },
    onError: (_err, _value, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(queryKey, ctx.previous);
      }
    },
    meta: { errorTitle },
  });
}
