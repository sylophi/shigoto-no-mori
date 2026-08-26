// Immediate writer for the keepReachable opt-in (v2 step 4, slice E).
// Unlike appearance, which stages in the settings form and persists on
// Save, this toggle takes effect at once: flipping it should register or
// clear the OS login item right away, which the main-side write handler
// does when the value changes.
//
// The whole-document merge-and-write lives in mergeClientConfigWrite, so
// this file only supplies its one key. keepReachable is off by default,
// so it is stored only when explicitly on (undefined omits it).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";
import { mergeClientConfigWrite } from "./mergeClientConfigWrite";

export function useKeepReachableUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (next: boolean): Promise<ClientConfig> =>
      mergeClientConfigWrite(queryClient, {
        keepReachable: next ? true : undefined,
      }),
    onMutate: async (next: boolean) => {
      // Update the cache optimistically so a concurrent appearance Save
      // that reads keepReachable from the cache during this toggle's
      // in-flight window sees the intended value. Without this, that Save
      // would read the pre-toggle value, write it through, and revert the
      // just-toggled setting. Cancel any in-flight refetch first so it
      // cannot clobber the optimistic value, and capture the previous doc
      // to roll back on error.
      await queryClient.cancelQueries({ queryKey: queryKeys.clientConfig() });
      const previous = queryClient.getQueryData<ClientConfig>(
        queryKeys.clientConfig(),
      );
      queryClient.setQueryData<ClientConfig>(queryKeys.clientConfig(), {
        ...previous,
        keepReachable: next ? true : undefined,
      });
      return { previous };
    },
    onError: (_error, _next, context) => {
      // Roll back to the doc captured before the optimistic update.
      queryClient.setQueryData(queryKeys.clientConfig(), context?.previous);
    },
    onSuccess: (config) => {
      // setQueryData rather than invalidate: the client store has no CLI
      // or host merge that could change it behind us, so the payload is
      // the new stored document (same rationale as useSettingsSave).
      queryClient.setQueryData(queryKeys.clientConfig(), config);
    },
    meta: { errorTitle: "Couldn't update device reachability" },
  });
}
