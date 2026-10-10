// The window's theme root: index.html's and web/index.html's #root, the
// element the theme classes, data-palette and data-shell live
// on (@shigomori/ui's root.tsx). The boot scripts stamp it before
// the first paint, and the theme hooks keep it in step.
export function themeRoot(): HTMLElement {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing from the page");
  return root;
}
