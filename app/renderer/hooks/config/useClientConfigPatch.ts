// The immediate client-config writer, for the keys that take effect on
// the spot rather than staging behind a Save: keepReachable, the
// forward local-port preferences. One hook body carries the protocol
// every such key needs, so the concurrency rule lives once:
//
// The patch is computed once, off the doc as it is when mutate is
// called, and becomes the mutation's variable. The cache takes it
// optimistically first so a concurrent appearance Save that reads the
// doc during this write's in-flight window sees the intended value
// (without that it would read the pre-write value, write it through,
// and revert the change just made). Any in-flight refetch is cancelled
// first so it cannot clobber the optimistic value, the previous doc is
// kept to roll back on error, and success re-applies the patch over
// whatever the cache holds by then rather than setting this write's
// own snapshot: two patches in flight (two ports' local-port
// preferences) would otherwise have the first's snapshot erase the
// second's key.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";
import { mergeClientConfigWrite } from "./mergeClientConfigWrite";

export function useClientConfigPatch<Input>(
  // The keys to overlay for a given input, computed off the doc as it
  // is now. An undefined value omits its key (the store's
  // omit-on-default serialization).
  patchFor: (
    input: Input,
    current: ClientConfig | undefined,
  ) => Partial<ClientConfig>,
  errorTitle: string,
) {
  const queryClient = useQueryClient();
  const current = () =>
    queryClient.getQueryData<ClientConfig>(queryKeys.clientConfig());
  const apply = (patch: Partial<ClientConfig>) =>
    queryClient.setQueryData<ClientConfig>(queryKeys.clientConfig(), {
      ...current(),
      ...patch,
    });
  const mutation = useMutation({
    mutationFn: (patch: Partial<ClientConfig>): Promise<ClientConfig> =>
      mergeClientConfigWrite(queryClient, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.clientConfig() });
      const previous = current();
      apply(patch);
      return { previous };
    },
    onError: (_error, _patch, context) => {
      queryClient.setQueryData(queryKeys.clientConfig(), context?.previous);
    },
    onSuccess: (_config, patch) => {
      apply(patch);
    },
    meta: { errorTitle },
  });
  return {
    mutate: (input: Input) => mutation.mutate(patchFor(input, current())),
    isPending: mutation.isPending,
  };
}
