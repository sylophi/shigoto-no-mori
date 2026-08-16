// Which window this renderer document is running in. Both windows load
// the same bundle -- the menu bar popover (main/electron/tray) just adds
// `?surface=tray` to the URL -- so that one component tree and one theme
// system cover both. renderer/index.tsx branches on this once, at the
// root; everything below it is ordinary app UI.
export type Surface = "main" | "tray";

export const surface: Surface =
  new URLSearchParams(window.location.search).get("surface") === "tray"
    ? "tray"
    : "main";

export const isTraySurface = surface === "tray";
