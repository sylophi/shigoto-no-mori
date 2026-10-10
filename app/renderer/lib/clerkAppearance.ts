// Binds Clerk's prebuilt components to the app's live theme without
// forking their structure: every value is a CSS variable reference,
// which ClerkGate resolves against the theme root (Clerk's modal mounts
// outside it) whenever light/dark or the doubutsu overlay changes. Clerk's UI
// is outside doubutsu.css's selector contract. This appearance object
// is its entire theming surface, so keep it to theme tokens
// (theme-contract verifies every bare var here still resolves in both
// systems) and eyeball all four modes when touching it.
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
    // --input, not --border: doubutsu deliberately sets --border to
    // transparent (its surfaces separate by fill, with edges re-added
    // through data-slot rules Clerk's DOM can't carry), while the input
    // token stays a visible tone in all four modes.
    colorBorder: "var(--input)",
    colorRing: "var(--ring)",
    colorDanger: "var(--destructive)",
    // The two status hues from the app's sanctioned raw families
    // (emerald = success, amber = warning), on the exact steps
    // doubutsu.css remaps in BOTH its light and dark blocks.
    colorSuccess: "var(--color-emerald-500)",
    colorWarning: "var(--color-amber-500)",
    // Clerk's default backdrop is colorNeutral at 73%, a near-white
    // scrim in dark modes. A dark scrim is the app's own overlay
    // convention (primitives/sheet.tsx's bg-black/10), mode-independent, so a
    // literal is right here.
    colorModalBackdrop: "rgb(0 0 0 / 0.4)",
    borderRadius: "var(--radius)",
    // Geist in v1, Zen Maru under doubutsu.
    fontFamily: "var(--font-sans)",
  },
};
