import { useQueryClient } from "@tanstack/react-query";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import {
  DEFAULT_LIGHT_THEME,
  type LightTheme,
  LIGHT_THEMES,
  nextVariant,
} from "@shigomori/ui/lib/themes.ts";
import { useClientConfigPatch } from "@/hooks/config/useClientConfigPatch";
import { queryKeys } from "@/lib/queryKeys";
import { useKeymapAction } from "./useKeymap";
import { usePalette } from "./usePalette";
import { useTheme } from "./useTheme";

// The keymap's paletteVariant (Ctrl+Alt+Shift+L), the hidden way to a
// palette's variants
// (packages/ui/src/lib/themes.ts): steps the saved light pick through its
// swatch's cycle and saves it at once. Every build has it. It acts only
// while the window shows that saved pick (light, doubutsu on, no preview
// staged over it) and the caller enables it, which AppShell does off
// Settings, whose form keeps a staged copy of the pick its Save would write
// back.
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

  useKeymapAction(
    "paletteVariant",
    () => {
      // Read at press time, as useSidebarViewHotkey does: two quick
      // presses off the rendered pick would both write the same step.
      const current =
        queryClient.getQueryData<ClientConfig>(queryKeys.clientConfig())
          ?.lightTheme ?? DEFAULT_LIGHT_THEME;
      const next = nextVariant(LIGHT_THEMES, current);
      if (next === null) return false;
      mutate(next);
    },
    { enabled: listening },
  );
}
