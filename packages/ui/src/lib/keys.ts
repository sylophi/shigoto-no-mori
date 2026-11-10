import { isMac } from "./platform.ts";

// The keys no one rebinds, as this platform's keyboards print them: the
// Mac's glyphs there, the names the keymap's chords use elsewhere
// (keymap.ts). A hint spelled at its call site would show a Mac's
// glyph beside "Ctrl+Enter".
export const KEYS = isMac
  ? {
      enter: "↩",
      tab: "⇥",
      backspace: "⌫",
      shift: "⇧",
      modClick: "⌘click",
    }
  : {
      enter: "Enter",
      tab: "Tab",
      backspace: "Backspace",
      shift: "Shift",
      modClick: "Ctrl+click",
    };

// Whether a click held the platform's `Mod` (KEYS.modClick). Ctrl with
// a click on a Mac is the context menu's.
export function isModClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}
