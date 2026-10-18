// This window's guide as its shell serves it (contracts' modules/guide.ts):
// read, then kept as the shell pushes each change. Null while no guide
// drives the window, and on a client with no shell of its own.
import {
  guideContract,
  type GuideHarness,
  type GuideState,
  isGuideHarness,
} from "@shigomori/contracts/modules/guide";
import { callOf } from "@shigomori/contracts/contract";
import { useQuery } from "@tanstack/react-query";
import * as Atom from "effect/reactivity/Atom";
import { useHasLocalHost } from "@/lib/localHost";
import { notifyError } from "@/lib/toast";
import { queryKeysFor } from "@/lib/queryKeys";
import { clientAtoms, shellState } from "@/lib/runtime/atoms";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";
import { useView } from "@/lib/runtime/viewHooks";

const guideAtom = Atom.keepAlive(
  clientAtoms.atom(
    shellState(guideContract, {
      read: callOf(guideContract, "read"),
      push: callOf(guideContract, "changed"),
    }),
  ),
);

export function useGuide(): GuideState | null {
  return useView(useHasLocalHost() ? guideAtom : null).data ?? null;
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

// Opens a harness guiding this window (its shell's guide:start), for
// the Help menu's items and the sidebar's guide menu alike.
export function startGuide(api: RendererApi, harness: GuideHarness): void {
  void api
    .run(api.guide.start({ harness }))
    .catch((error: unknown) => notifyError("Couldn't open the guide", error));
}
