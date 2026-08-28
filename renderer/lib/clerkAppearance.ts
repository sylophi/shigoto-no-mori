// Binds Clerk's prebuilt components to the app's live theme without
// forking their structure: every value is a CSS variable reference, so
// light/dark and the doubutsu overlay (which remaps the same tokens)
// propagate into Clerk's portaled surfaces with no remount. Clerk's UI
// is deliberately outside doubutsu.css and theme:check — this appearance
// object is its entire theming surface, so keep it to theme tokens
// (never literals) and eyeball all four modes when touching it.
import type { ClerkProviderProps } from "@clerk/react";

export const clerkAppearance: ClerkProviderProps["appearance"] = {
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-foreground)",
    colorBackground: "var(--card)",
    colorForeground: "var(--card-foreground)",
    colorNeutral: "var(--card-foreground)",
    colorMuted: "var(--muted)",
    colorMutedForeground: "var(--muted-foreground)",
    colorInput: "var(--secondary)",
    colorInputForeground: "var(--secondary-foreground)",
    colorBorder: "var(--border)",
    colorRing: "var(--ring)",
    colorDanger: "var(--destructive)",
    // The two status hues from the app's sanctioned raw families
    // (emerald = success, amber = warning), which doubutsu remaps.
    colorSuccess: "var(--color-emerald-600)",
    colorWarning: "var(--color-amber-600)",
    borderRadius: "var(--radius)",
    fontFamily: "var(--font-sans)",
  },
};
