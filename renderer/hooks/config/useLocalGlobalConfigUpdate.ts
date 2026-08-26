// Mutation shared by the hosting and remote-device settings sections (v2
// step 3, slice C). It read-modify-writes the unredacted local config,
// then reconciles the outbound device registry and refreshes the
// redacted read the sections display from. Sourcing the base from the
// unredacted readLocal is what keeps socketHost.token and the
// remoteDevices tokens through a whole-document CLI write.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GlobalConfig } from "@shared/schemas";
import { updateLocalGlobalConfig } from "@/lib/config/localGlobalConfig";
import { reconcileRemoteDevicesFromConfig } from "@/lib/remote/registry";
import { queryKeys } from "@/lib/queryKeys";

export function useLocalGlobalConfigUpdate(errorTitle: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: (base: GlobalConfig) => GlobalConfig) =>
      updateLocalGlobalConfig(update),
    onSuccess: async () => {
      // Re-reconcile after any write that changes remoteDevices or
      // socketHost, so a device the user added starts connecting and one
      // they removed drops. A socketHost-only change reconciles the same
      // wanted list harmlessly.
      await reconcileRemoteDevicesFromConfig();
      // The sections display from the redacted read, so refresh it to
      // reflect the new enabled/lan/port/tokenSet.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.globalConfig(),
      });
    },
    meta: { errorTitle },
  });
}
