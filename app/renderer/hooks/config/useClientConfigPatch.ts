// The immediate client-config writer, for the keys that take effect on
// the spot rather than staging behind a Save: keepReachable, the
// forward local-port preferences, the sidebar's view, sort and folds.
// The patch is computed off the config as this window shows it when
// mutate is called (a patch still on its way included), and is its own
// keys alone (patchClientConfig).
import { useMutation } from "@tanstack/react-query";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import { useApi } from "@/lib/runtime/pageApi";
import { useRegistry } from "@/lib/runtime/viewHooks";
import { clientConfigNow, patchClientConfig } from "./useClientConfig";

export function useClientConfigPatch<Input>(
  // The keys to overlay for a given input, computed off the doc as it
  // is now. An undefined value clears its key.
  patchFor: (
    input: Input,
    current: ClientConfig | undefined,
  ) => Partial<ClientConfig>,
  errorTitle: string,
) {
  const api = useApi();
  const registry = useRegistry();
  const mutation = useMutation({
    mutationFn: (patch: Partial<ClientConfig>) =>
      patchClientConfig(api, registry, patch),
    meta: { errorTitle },
  });
  return {
    mutate: (input: Input) =>
      mutation.mutate(patchFor(input, clientConfigNow(registry))),
    isPending: mutation.isPending,
  };
}
