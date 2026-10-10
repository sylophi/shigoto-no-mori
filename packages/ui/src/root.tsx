// The element a window's theme lives on: its theme classes (dark,
// doubutsu), data-palette and data-shell, and the tokens they select. The app's root, or a scene's frame. Menus, popovers,
// tooltips and dialogs mount inside it, so they wear the theme of the
// window they open in, and a view that follows the theme (the
// terminal) watches it. Null where there is none to mount into (a
// server render), where a dialog draws in place.
import { createContext, useContext } from "react";

const ThemeRootContext = createContext<HTMLElement | null>(null);

export const ThemeRootProvider = ThemeRootContext.Provider;

export function useThemeRoot(): HTMLElement | null {
  return useContext(ThemeRootContext);
}
