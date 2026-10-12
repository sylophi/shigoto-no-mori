// This window's guide as its shell serves it (contracts' modules/guide.ts):
// read once, then kept as the shell pushes each change. Null while no
// guide drives the window, and on a client with no shell of its own.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  guideContract,
  type GuideHarness,
  type GuideState,
  isGuideHarness,
} from "@shigomori/contracts/modules/guide";
import { useHasLocalHost } from "@/lib/localHost";
import { queryKeys, queryKeysFor } from "@/lib/queryKeys";
import { useApi } from "@/lib/runtime/pageApi";

export function useGuide(): GuideState | null {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!hasLocalHost) return;
    return api.listen(api.pushes(guideContract, "changed"), (state) => {
      queryClient.setQueryData(queryKeys.guide(), state);
    });
  }, [queryClient, api, hasLocalHost]);
  const { data } = useQuery({
    queryKey: queryKeys.guide(),
    queryFn: ({ signal }) => api.run(api.guide.read(), { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: hasLocalHost,
  });
  return hasLocalHost ? (data ?? null) : null;
}

// The agents a guide can open on this machine: those of the guide's
// harnesses that are set up here, undefined until read. Read once a
// minute at most.
export function useGuideHarnesses(): GuideHarness[] | undefined {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const { data } = useQuery({
    queryKey: queryKeysFor(api.deviceId).agents(),
    queryFn: ({ signal }) => api.run(api.agents.status(), { signal }),
    staleTime: 60_000,
    enabled: hasLocalHost,
  });
  return data?.flatMap(({ id, detected }) =>
    detected && isGuideHarness(id) ? [id] : [],
  );
}
