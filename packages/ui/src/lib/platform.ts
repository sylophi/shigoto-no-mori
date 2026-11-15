// The OS of the machine the window runs on, as its keyboards and its
// file manager go. A phone or tablet browser counts as a Mac, whose
// glyphs its keyboards print. So does a render with no browser (the
// marketing site's frames, drawn at build time), which poses one as the
// scenes' own keys do.
export const viewerOs: "mac" | "windows" | "other" =
  typeof window === "undefined" || /Mac|iPhone|iPad/.test(navigator.platform)
    ? "mac"
    : navigator.platform.startsWith("Win")
      ? "windows"
      : "other";

// ⌘ or Ctrl: which key `Mod` is here.
export const isMac = viewerOs === "mac";
