// This window's guide as its shell serves it (contracts' modules/guide.ts):
// read once, then kept as the shell pushes each change. Null while no
// guide drives the window, and on a client with no shell of its own.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GUIDE_HARNESS_LABELS,
  type GuideState,
  isGuideHarness,
} from "@shigomori/contracts/modules/guide";
import type { GuideHarnessOption } from "@shigomori/ui/views/palette/paletteEntries.ts";
import { useHasLocalHost } from "@/lib/localHost";
import { queryKeys, queryKeysFor } from "@/lib/queryKeys";
import { useApi } from "@/lib/runtime/pageApi";

export function useGuide(): GuideState | null {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!hasLocalHost) return;
    return api.guide.onChanged((state) => {
      queryClient.setQueryData(queryKeys.guide(), state);
    });
  }, [queryClient, api, hasLocalHost]);
  const { data } = useQuery({
    queryKey: queryKeys.guide(),
    queryFn: () => api.guide.read(),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: hasLocalHost,
  });
  return hasLocalHost ? (data ?? null) : null;
}

// The agents a guide can open on this machine: those of the guide's
// harnesses that are set up here, none as null. Read once a minute at
// most: the palette mounts on every open.
export function useGuideHarnesses():
  | [GuideHarnessOption, ...GuideHarnessOption[]]
  | null {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const { data } = useQuery({
    queryKey: queryKeysFor(api.deviceId).agents(),
    queryFn: () => api.agents.status(),
    staleTime: 60_000,
    enabled: hasLocalHost,
  });
  const [first, ...rest] = (data ?? []).flatMap((harness) =>
    harness.detected && isGuideHarness(harness.id)
      ? [{ id: harness.id, label: GUIDE_HARNESS_LABELS[harness.id] }]
      : [],
  );
  return first === undefined ? null : [first, ...rest];
}
