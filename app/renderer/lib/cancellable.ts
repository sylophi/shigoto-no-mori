import {
  CancelledError,
  type MutateOptions,
  type UseMutationResult,
} from "@tanstack/react-query";

// A mutation's input with what stops its run.
export type Abortable<V> = V & { abort: AbortController };

// A mutationFn handed its run's signal, failing as React Query's cancel
// (which no toast reports) once stopped. A run that finished first
// lands as it would.
export const abortable =
  <V, A>(run: (input: V, signal: AbortSignal) => Promise<A>) =>
  ({ abort, ...input }: Abortable<V>): Promise<A> =>
    run(input as V, abort.signal).catch((error: unknown) => {
      throw abort.signal.aborted ? new CancelledError() : error;
    });

const start = <V extends object>(input: V): Abortable<V> => ({
  ...input,
  abort: new AbortController(),
});

// The mutation, each run given its own AbortController, and `cancel`
// stopping the latest.
export function withAbort<A, V extends object>(
  mutation: UseMutationResult<A, Error, Abortable<V>>,
) {
  return {
    ...mutation,
    mutate: (input: V, options?: MutateOptions<A, Error, Abortable<V>>) =>
      mutation.mutate(start(input), options),
    mutateAsync: (input: V, options?: MutateOptions<A, Error, Abortable<V>>) =>
      mutation.mutateAsync(start(input), options),
    cancel: () => mutation.variables?.abort.abort(),
  };
}
