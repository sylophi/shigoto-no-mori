// This window's guide as its shell serves it (contracts' modules/guide.ts):
// read, then kept as the shell pushes each change. Null while no guide
// drives the window, and on a client with no shell of its own.
import {
  guideContract,
  type GuideChoices,
  type GuideStart,
  type GuideState,
  isGuideHarness,
} from "@shigomori/contracts/modules/guide";
import { callOf } from "@shigomori/contracts/contract";
import {
  DEVICE_SETTINGS_DEFAULTS,
  installedTerminals,
} from "@shigomori/contracts/schemas";
import { useQuery } from "@tanstack/react-query";
import * as Atom from "effect/reactivity/Atom";
import { useLocalGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useHasLocalHost } from "@/lib/localHost";
import { notifyError } from "@/lib/toast";
import { queryKeysFor } from "@/lib/queryKeys";
import { clientAtoms, shellState } from "@/lib/runtime/atoms";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";
import { useView } from "@/lib/runtime/viewHooks";

// One the shell refused in its own words is not asked again this window
// (redialing ends it), as the shell answering at all is the window's
// premise.
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

// What a guide can open on this machine: those of the guide's harnesses
// that are set up here, and while the `terminal` setting is the app's
// own, the terminal apps installed here to ask between. Undefined until
// read. The harnesses are read once a minute at most.
export function useGuideChoices(): GuideChoices | undefined {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const keys = queryKeysFor(api.deviceId);
  const { data: agents } = useQuery({
    queryKey: keys.agents(),
    queryFn: ({ signal }) => api.run(api.agents.status(), { signal }),
    staleTime: 60_000,
    enabled: hasLocalHost,
  });
  const config = useLocalGlobalConfig().data;
  const terminal = config?.terminal ?? DEVICE_SETTINGS_DEFAULTS.terminal;
  const { data: launchers, isPending } = useQuery({
    queryKey: keys.detectedLaunchers(),
    queryFn: ({ signal }) => api.run(api.launchers.detect(), { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: hasLocalHost && config !== undefined && terminal === "app",
  });
  if (agents === undefined || config === undefined) return undefined;
  const harnesses = agents.flatMap(({ id, detected }) =>
    detected && isGuideHarness(id) ? [id] : [],
  );
  if (terminal !== "app") return { harnesses, terminals: [] };
  if (isPending) return undefined;
  // One installed (Terminal) leaves nothing to ask, and a failed read
  // leaves the guide where it opened before.
  const terminals = installedTerminals(launchers ?? []);
  return {
    harnesses,
    terminals:
      terminals.length < 2
        ? []
        : terminals.map(({ id, entry }) => ({ id, label: entry.label })),
  };
}

// Opens a harness guiding this window (its shell's guide:start), for
// the Help menu's items and the sidebar's guide menu alike.
export function startGuide(api: RendererApi, start: GuideStart): void {
  void api
    .run(api.guide.start(start))
    .catch((error: unknown) => notifyError("Couldn't open the guide", error));
}
