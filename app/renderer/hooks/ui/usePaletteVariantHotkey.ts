import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import {
  DEFAULT_LIGHT_THEME,
  type LightTheme,
  LIGHT_THEMES,
  nextVariant,
} from "@shared/themes";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";
import { isEditableTarget, isOverlayOpen, isRawKeySurface } from "@/lib/dom";
import { queryKeys } from "@/lib/queryKeys";
import { usePalette } from "./usePalette";
import { useTheme } from "./useTheme";

// Ctrl+Alt+Shift+L, the hidden way to a palette's variants
// (shared/themes.ts): steps the saved light pick through its swatch's
// cycle and saves it at once. Every build has it. It listens only while
// the window shows that saved pick (light, doubutsu on, no preview
// staged over it) and the caller enables it, which AppShell does off
// Settings, whose form keeps a staged copy of the pick its Save would
// write back.
export function usePaletteVariantHotkey(enabled: boolean): void {
  const queryClient = useQueryClient();
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
        queryClient.getQueryData<ClientConfig>(queryKeys.clientConfig())
          ?.lightTheme ?? DEFAULT_LIGHT_THEME;
      const next = nextVariant(LIGHT_THEMES, current);
      if (next === null) return;
      e.preventDefault();
      mutate(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // mutate is a fresh closure per render (the patch hook rebuilds it),
    // and the handler reads the pick from the cache, so re-subscribing
    // on every render would be churn for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, queryClient]);
}
