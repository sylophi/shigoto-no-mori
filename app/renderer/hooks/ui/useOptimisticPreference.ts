import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";

interface PreferenceContext<T> {
  previous?: T;
}

// One optimistic write for a single-value preference: cancel, snapshot,
// apply, roll back on failure. The cancelQueries is the load-bearing
// part. It stops an in-flight read clobbering the optimistic value.
// It takes effect without being awaited (a cancelled read's result is
// dropped), and onMutate stays synchronous so the new value is in the
// cache when mutate() returns: dnd-kit measures a dropped item right
// after onDragEnd, and a value applied a tick later makes the drop
// animate back to the old slot before blinking into the new one.
export function useOptimisticPreference<T>(
  queryKey: QueryKey,
  write: (value: T) => Promise<void>,
  errorTitle: string,
) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, T, PreferenceContext<T>>({
    mutationFn: write,
    onMutate: (value) => {
      void queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<T>(queryKey);
      queryClient.setQueryData(queryKey, value);
      return { previous };
    },
    onError: (_err, _value, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(queryKey, ctx.previous);
      }
    },
    // The host's answer wins in the end. A rollback restores the value
    // from when this write started, which a later write may have moved
    // past, and a write the host merges (the scripts order) isn't the
    // value it stores.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
    meta: { errorTitle },
  });
}
