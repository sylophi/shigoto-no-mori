// The palette rotation (Settings > Appearance, packages/ui's themes.ts
// rotationTurn): a turn at launch, before the first render so the
// window opens in the new palette, then a check each minute for the
// timed ones. A turn patches the picks the way Settings would, so the
// next launch's boot mirror paints them.
import { rotationTurn } from "@shigomori/ui/lib/themes.ts";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import {
  clientConfigNow,
  clientConfigOnce,
  patchClientConfig,
} from "@/hooks/config/useClientConfig";
import type { RendererApi } from "@/lib/runtime/pageApi";

const CHECK_MS = 60 * 1000;

const warn = (error: unknown) => console.warn("[themeRotation]", error);

// Settings holds the rotation while it is open, so the palette stays
// put while its picks are being looked at.
let holds = 0;
export function holdThemeRotation(): () => void {
  holds += 1;
  return () => {
    holds -= 1;
  };
}

// The window shows the turn at once, before the store's owner hands it
// back, so the launch's render waits on the read alone. A failed patch
// takes it back, and warns rather than toasting every minute.
async function turn(
  api: RendererApi,
  registry: AtomRegistry.AtomRegistry,
  launching: boolean,
) {
  if (holds > 0) return;
  const config = launching
    ? await clientConfigOnce(registry)
    : clientConfigNow(registry);
  if (config === undefined) return;
  const patch = rotationTurn(config, Date.now(), launching);
  if (patch) void patchClientConfig(api, registry, patch).catch(warn);
}

export async function startThemeRotation(
  api: RendererApi,
  registry: AtomRegistry.AtomRegistry,
): Promise<void> {
  setInterval(() => void turn(api, registry, false).catch(warn), CHECK_MS);
  await turn(api, registry, true).catch(warn);
}
