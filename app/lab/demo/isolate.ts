// Keeps each marketing frame to itself (see main.tsx). Its own module,
// imported first, because module bodies run in import order and some
// lab modules touch localStorage as they load (villagerData.ts poses
// the Visitors album).

// Storage per frame: the pose writes the theme to localStorage, and a
// dark frame's write would otherwise reach the light frame beside it
// (and a visitor's own clicks would outlive a reload).
const items = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return items.size;
  },
  key: (index) => [...items.keys()][index] ?? null,
  getItem: (key) => items.get(key) ?? null,
  setItem: (key, value) => void items.set(key, String(value)),
  removeItem: (key) => void items.delete(key),
  clear: () => items.clear(),
};
Object.defineProperty(window, "localStorage", { value: memoryStorage });

// No focus until the visitor reaches into the frame. A dialog or field
// that focuses itself on mount would otherwise take the keyboard from
// the page around it, and scroll the page to this frame. The page's own
// posing clicks (marketing/src/scripts/live.ts) are untrusted events,
// so they don't count.
let touched = false;
for (const kind of ["pointerdown", "keydown"] as const) {
  addEventListener(
    kind,
    (event) => {
      if (event.isTrusted) touched = true;
    },
    { capture: true },
  );
}
const focus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (this: HTMLElement, options) {
  if (touched) focus.call(this, options);
};
