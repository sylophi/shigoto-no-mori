import { useEffect, useEffectEvent } from "react";
import {
  DEFAULT_LIGHT_THEME,
  type LightTheme,
  LIGHT_THEMES,
  nextVariant,
} from "@shigomori/ui/lib/themes.ts";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";
import { isEditableTarget, isOverlayOpen, isRawKeySurface } from "@/lib/dom";
import { useRegistry } from "@/lib/runtime/viewHooks";
import { clientConfigNow } from "@/hooks/config/useClientConfig";
import { usePalette } from "./usePalette";
import { useTheme } from "./useTheme";

// Ctrl+Alt+Shift+L, the hidden way to a palette's variants
// (packages/ui/src/lib/themes.ts): steps the saved light pick through its
// swatch's cycle and saves it at once. Every build has it. It is hidden,
// so it stays outside the keymap (lib/keymap.ts), like the dev builds'
// theme keys. It listens only
// while the window shows that saved pick (light, doubutsu on, no preview
// staged over it) and the caller enables it, which AppShell does off
// Settings, whose form keeps a staged copy of the pick its Save would write
// back.
export function usePaletteVariantHotkey(enabled: boolean): void {
  const registry = useRegistry();
  const { resolved } = useTheme();
  const { saved, applied } = usePalette();
  const { mutate } = useClientConfigPatch(
    (next: LightTheme) => ({ lightTheme: next }),
    "Couldn't switch the palette",
  );
  const listening =
    enabled &&
    applied.doubutsu &&
    resolved === "light" &&
    applied.light === saved.light &&
    nextVariant(LIGHT_THEMES, saved.light) !== null;

  // The handler reads the pick from the registry at press time, so it
  // subscribes once while listening.
  const pick = useEffectEvent(mutate);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.code !== "KeyL" ||
        !(e.ctrlKey && e.altKey && e.shiftKey) ||
        e.metaKey ||
        e.repeat ||
        e.isComposing
      ) {
        return;
      }
      if (isEditableTarget(e.target) || isRawKeySurface(e.target)) return;
      if (isOverlayOpen()) return;
      // Read at press time, as useSidebarViewHotkey does: two quick
      // presses off the rendered pick would both write the same step.
      const current =
        clientConfigNow(registry)?.lightTheme ?? DEFAULT_LIGHT_THEME;
      const next = nextVariant(LIGHT_THEMES, current);
      if (next === null) return;
      e.preventDefault();
      pick(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening, registry]);
}
