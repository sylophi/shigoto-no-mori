// The palette rotation (Settings > Appearance, packages/ui's themes.ts
// rotationTurn), which the client config's owner turns
// (clientConfig:rotate): asked at launch, before the first render, then
// each minute for the timed ones. The owner makes the launch's turn
// once however many windows ask.
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import {
  clientConfigNow,
  clientConfigOnce,
  whenClientConfigShows,
} from "@/hooks/config/useClientConfig";
import type { RendererApi } from "@/lib/runtime/pageApi";

const CHECK_MS = 60 * 1000;

const warn = (error: unknown) => console.warn("[themeRotation]", error);

// Settles once this window shows its config, the launch's turn in it if
// one was made, so the first frame wears the palette it moved to.
async function turnAtLaunch(
  api: RendererApi,
  registry: AtomRegistry.AtomRegistry,
): Promise<void> {
  const stamp = await api
    .run(api.clientConfig.rotate({ launching: true }))
    .catch((error: unknown) => {
      warn(error);
      return null;
    });
  if (stamp === null) {
    await clientConfigOnce(registry);
    return;
  }
  await whenClientConfigShows(
    registry,
    (config) => config.themeRotatedAt === stamp,
  );
}

// Settings holds this window's checks while it is open, so the palette
// stays put while its picks are being looked at.
let holds = 0;
export function holdThemeRotation(): () => void {
  holds += 1;
  return () => {
    holds -= 1;
  };
}

export function startThemeRotation(
  api: RendererApi,
  registry: AtomRegistry.AtomRegistry,
  signal: AbortSignal,
): Promise<void> {
  // Only a timed rotation has anything to check between launches.
  const checks = setInterval(() => {
    const every = clientConfigNow(registry)?.themeRotation;
    if (holds > 0 || every === undefined || every === "launch") return;
    void api.run(api.clientConfig.rotate({ launching: false })).catch(warn);
  }, CHECK_MS);
  signal.addEventListener("abort", () => clearInterval(checks));
  // Whatever goes wrong, the window still renders.
  return turnAtLaunch(api, registry).catch(warn);
}
