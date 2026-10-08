// The doubutsu palette catalog behind Settings > Appearance: what each
// pick is called, and how a stored client config decodes into the
// switch and the two picks. The ids are the schema's
// (packages/contracts/src/schemas/config.ts), and the colors the stylesheets' (DESIGN.md,
// "Theming").
import {
  type ClientConfig,
  type DarkTheme,
  DARK_THEME_IDS,
  type LightTheme,
  LIGHT_THEME_IDS,
} from "@shigomori/contracts/schemas/config";

export { DARK_THEME_IDS, LIGHT_THEME_IDS };
export type { DarkTheme, LightTheme };

export const DEFAULT_LIGHT_THEME: LightTheme = "cream";
export const DEFAULT_DARK_THEME: DarkTheme = "charcoal";

export interface ThemeOption<Id extends string> {
  id: Id;
  label: string;
  // The swatch's tooltip in the picker.
  blurb: string;
  // Alternates to this palette that differ in a detail (latte's
  // greens), kept out of the picker while their fate is open. Only the
  // hidden hotkey reaches them (hooks/ui/usePaletteVariantHotkey.ts),
  // and it steps light picks alone for now. The swatch stands for them
  // all: it shows chosen, in the variant's colors, while one is the
  // pick.
  variants?: readonly Id[];
}

// Whether a pick is this swatch's palette or one of its variants.
export function optionHolds<Id extends string>(
  option: ThemeOption<Id>,
  id: Id,
): boolean {
  return option.id === id || (option.variants?.includes(id) ?? false);
}

// The pick after this one in its swatch's cycle (the palette, then
// each variant, then round again), or null for a swatch without
// variants.
export function nextVariant<Id extends string>(
  options: readonly ThemeOption<Id>[],
  id: Id,
): Id | null {
  const option = options.find((o) => optionHolds(o, id));
  if (!option?.variants) return null;
  const cycle = [option.id, ...option.variants];
  return cycle[(cycle.indexOf(id) + 1) % cycle.length] ?? null;
}

// The two lists pair by position, so the pickers stack each light
// swatch over its dark twin.
export const LIGHT_THEMES: readonly ThemeOption<LightTheme>[] = [
  {
    id: "snow",
    label: "Snow",
    blurb: "Cool white, the mint kept for the rail",
  },
  { id: "meadow", label: "Meadow", blurb: "Mint all over, deeper on the rail" },
  { id: "cream", label: "Cream", blurb: "Warm paper and a mint rail" },
  {
    id: "latte",
    label: "Latte",
    blurb: "Milky coffee, cocoa by day",
    variants: ["latte-sage", "latte-mocha"],
  },
  { id: "sky", label: "Sky", blurb: "A clear morning, blue on white" },
  { id: "sakura", label: "Sakura", blurb: "Blossom pink all through" },
];

export const DARK_THEMES: readonly ThemeOption<DarkTheme>[] = [
  { id: "charcoal", label: "Charcoal", blurb: "Near-black, a mossy rail" },
  { id: "forest", label: "Forest", blurb: "Deep green, night in the woods" },
  { id: "wood", label: "Wood", blurb: "The first night: cream, darkened" },
  { id: "cocoa", label: "Cocoa", blurb: "Warm brown, lamplight" },
  { id: "midnight", label: "Midnight", blurb: "Navy sky, a moonlit aqua" },
  {
    id: "yozakura",
    label: "Yozakura",
    blurb: "Blossoms at night, under lanterns",
  },
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
