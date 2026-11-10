import {
  CancelledError,
  type MutateOptions,
  type UseMutationOptions,
  useMutation,
} from "@tanstack/react-query";

// A mutation's input with what stops its run.
export type Abortable<V> = V & { abort: AbortController };

const start = <V extends object>(input: V): Abortable<V> => ({
  ...input,
  abort: new AbortController(),
});

// useMutation whose runs can be stopped: `mutationFn` is handed its
// run's signal, and `cancel` stops the latest run, which then fails as
// React Query's cancel (no toast reports it). A run that finished first
// lands as it would.
export function useAbortableMutation<A, V extends object>({
  mutationFn: run,
  ...rest
}: Omit<UseMutationOptions<A, Error, Abortable<V>>, "mutationFn"> & {
  mutationFn: (input: V, signal: AbortSignal) => Promise<A>;
}) {
  const mutation = useMutation<A, Error, Abortable<V>>({
    ...rest,
    mutationFn: ({ abort, ...input }) =>
      run(input as V, abort.signal).catch((error: unknown) => {
        throw abort.signal.aborted ? new CancelledError() : error;
      }),
  });
  return {
    ...mutation,
    mutate: (input: V, options?: MutateOptions<A, Error, Abortable<V>>) =>
      mutation.mutate(start(input), options),
    mutateAsync: (input: V, options?: MutateOptions<A, Error, Abortable<V>>) =>
      mutation.mutateAsync(start(input), options),
    cancel: () => mutation.variables?.abort.abort(),
  };
}
