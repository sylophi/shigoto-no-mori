// The doubutsu palette catalog behind Settings > Appearance: what each
// pick is called, and how a stored client config decodes into the
// switch and the two picks. The ids are the schema's
// (shared/schemas/config.ts), and the colors the stylesheets' (DESIGN.md,
// "Theming").
import {
  type ClientConfig,
  type DarkTheme,
  DARK_THEME_IDS,
  type LightTheme,
  LIGHT_THEME_IDS,
} from "./schemas/config";

export { DARK_THEME_IDS, LIGHT_THEME_IDS };
export type { DarkTheme, LightTheme };

export const DEFAULT_LIGHT_THEME: LightTheme = "cream";
export const DEFAULT_DARK_THEME: DarkTheme = "charcoal";

export interface ThemeOption<Id extends string> {
  id: Id;
  label: string;
  // The swatch's tooltip in the picker.
  blurb: string;
}

export const LIGHT_THEMES: readonly ThemeOption<LightTheme>[] = [
  {
    id: "snow",
    label: "Snow",
    blurb: "Cool white, the mint kept for the rail",
  },
  { id: "meadow", label: "Meadow", blurb: "Mint all over, deeper on the rail" },
  { id: "cream", label: "Cream", blurb: "Warm paper and a mint rail" },
  { id: "sky", label: "Sky", blurb: "A clear morning, blue on white" },
  { id: "sakura", label: "Sakura", blurb: "Blossom pink, leaf green to act" },
];

export const DARK_THEMES: readonly ThemeOption<DarkTheme>[] = [
  { id: "charcoal", label: "Charcoal", blurb: "Near-black, a mossy rail" },
  { id: "forest", label: "Forest", blurb: "Deep green, night in the woods" },
  { id: "wood", label: "Wood", blurb: "The first night: cream, darkened" },
  { id: "midnight", label: "Midnight", blurb: "Navy sky over a teal rail" },
  { id: "cocoa", label: "Cocoa", blurb: "Warm brown, lamplight" },
];

// The appearance settings the overlay reads: the switch, and the pick
// each appearance wears while it is on.
export interface DoubutsuPicks {
  doubutsu: boolean;
  light: LightTheme;
  dark: DarkTheme;
}

export function resolveDoubutsuPicks(
  config: Pick<ClientConfig, "doubutsu" | "lightTheme" | "darkTheme">,
): DoubutsuPicks {
  return {
    doubutsu: config.doubutsu ?? true,
    light: config.lightTheme ?? DEFAULT_LIGHT_THEME,
    dark: config.darkTheme ?? DEFAULT_DARK_THEME,
  };
}

// The palette the current appearance wears, or null with the switch
// off.
export function activeTheme(
  picks: DoubutsuPicks,
  resolved: "light" | "dark",
): LightTheme | DarkTheme | null {
  if (!picks.doubutsu) return null;
  return resolved === "dark" ? picks.dark : picks.light;
}
