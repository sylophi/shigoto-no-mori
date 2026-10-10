// A window's theme root: the element its theme classes, data-palette
// and data-shell live on (@shigomori/ui's root.tsx), the one mountWindow
// renders into. A desktop window's and a browser tab's is their page's
// #root, which the boot scripts stamp before the first paint; a frame on
// the marketing site is one element of many on its page.
import { useThemeRoot } from "@shigomori/ui/root.tsx";

// The page's #root, for the entries that mount their one window there.
export function pageRoot(): HTMLElement {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing from the page");
  return root;
}

// The theme root of the window this component renders in.
export function useWindowRoot(): HTMLElement {
  const root = useThemeRoot();
  if (!root) throw new Error("rendered outside a mounted window");
  return root;
}
