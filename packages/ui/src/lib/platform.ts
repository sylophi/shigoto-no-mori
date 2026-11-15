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

// The side of a window its sidebar is on: the side the window's own
// buttons are, which sit in the sidebar's top strip, on the right on
// Windows and on the left on a Mac. The window's theme root says which
// (data-sidebar-side, from the desktop entry), and the stylesheet reads
// the same attribute (index.css's `sidebar-right:`). A root that says
// nothing, a browser tab's or a picture's, keeps the sidebar on the left.
export type SidebarSide = "left" | "right";

export const sidebarSideOf = (root: HTMLElement): SidebarSide =>
  root.dataset["sidebarSide"] === "right" ? "right" : "left";
