// This window's guide as its shell serves it (contracts' modules/guide.ts):
// read once, then kept as the shell pushes each change. Null while no
// guide drives the window, and on a client with no shell of its own.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type GuideState,
  isGuideHarness,
} from "@shigomori/contracts/modules/guide";
import type { GuideHarnessOption } from "@shigomori/ui/views/palette/paletteEntries.ts";
import { hasLocalHost } from "@/lib/localHost";
import { queryKeys } from "@/lib/queryKeys";

export function useGuide(): GuideState | null {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!hasLocalHost) return;
    return window.api.guide.onChanged((state) => {
      queryClient.setQueryData(queryKeys.guide(), state);
    });
  }, [queryClient]);
  const { data } = useQuery({
    queryKey: queryKeys.guide(),
    queryFn: () => window.api.guide.read(),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: hasLocalHost,
  });
  return hasLocalHost ? (data ?? null) : null;
}

// The agents a guide can open on this machine: those of the guide's
// harnesses that are set up here.
export function useGuideHarnesses(): GuideHarnessOption[] {
  const { data } = useQuery({
    queryKey: queryKeys.agents(),
    queryFn: () => window.api.agents.status(),
    enabled: hasLocalHost,
  });
  return (data ?? []).flatMap((harness) =>
    harness.detected && isGuideHarness(harness.id)
      ? [{ id: harness.id, label: harness.label }]
      : [],
  );
}
