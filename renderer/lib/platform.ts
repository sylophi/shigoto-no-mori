// Platform facts for the renderer, read synchronously from the preload
// bridge (available before any React code runs). UI that mirrors OS
// conventions (shortcut glyphs, title-bar insets) branches on these.
export const platform = window.api.platform;
export const isMac = platform === "darwin";
export const isWindows = platform === "win32";

// Display glyphs for modifiers: macOS symbols, spelled-out names
// elsewhere (matching the CmdOrCtrl accelerators the menu registers).
export const modKey = isMac ? "⌘" : "Ctrl";
export const shiftKey = isMac ? "⇧" : "Shift";

// Human-readable shortcut joined the way each OS writes it: "⌘N" on
// macOS, "Ctrl+N" elsewhere.
export function shortcutLabel(...keys: string[]): string {
  return isMac ? keys.join("") : keys.join("+");
}

// Name of the OS file manager, used by "Open in Finder" style
// affordances that must read as "Explorer" on Windows.
export const fileManagerName = isMac ? "Finder" : "Explorer";
