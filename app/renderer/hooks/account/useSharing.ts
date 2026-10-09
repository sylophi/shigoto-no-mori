// This device's sharing switch (packages/contracts/src/modules/sharing.ts),
// for its account page.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export function useSharing() {
  return useQuery<boolean>({
    queryKey: queryKeys.sharing(),
    queryFn: () => window.api.sharing.read(),
    meta: { errorTitle: "Couldn't read sharing" },
  });
}

// Writes the switch into its query as it moves, whoever moved it (this
// window, another one, `sm config` in a terminal).
export function useWatchSharingChanges(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      window.api.sharing.onChanged((on) => {
        queryClient.setQueryData(queryKeys.sharing(), on);
      }),
    [queryClient],
  );
}

// It does not update the query itself: the host's sharing:changed does.
export function useSetSharing() {
  return useMutation<void, Error, boolean>({
    mutationFn: (on) => window.api.sharing.set(on),
    meta: { errorTitle: "Couldn't change sharing" },
  });
}
