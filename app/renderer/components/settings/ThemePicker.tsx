import type {
  DarkTheme,
  LightTheme,
  ThemeOption,
} from "@shigomori/ui/lib/themes.ts";
import { usePalette } from "@/hooks/ui/usePalette";
import { ThemePickerView } from "@shigomori/ui/views/settings/ThemePickerView.tsx";

// A palette pick (ThemePickerView) over the palettes last saved.
export function ThemePicker<Id extends LightTheme | DarkTheme>(props: {
  appearance: "light" | "dark";
  options: readonly ThemeOption<Id>[];
  value: Id;
  onChange: (next: Id) => void;
  disabled?: boolean;
}) {
  const saved = usePalette().saved[props.appearance] as Id;
  return <ThemePickerView {...props} saved={saved} />;
}
