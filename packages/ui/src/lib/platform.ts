// ⌘ or Ctrl: which key `Mod` is here. A phone or tablet browser counts
// as a Mac, whose glyphs its keyboards print. So does a render with no
// browser (the marketing site's frames, drawn at build time), which
// poses one as the scenes' own keys do.
export const isMac =
  typeof window === "undefined" || /Mac|iPhone|iPad/.test(navigator.platform);
