// The live app frames on shigomori.com (marketing/README.md): the lab
// on its fixture bridge, built for the web and embedded in iframes,
// one per pose. The poses ride the URL as they do in the lab
// (lab/README.md), plus:
//   ?shell=web   the web shell, which under 768px wide is the phone
//                layout. Absent, the desktop window.
//
// Every frame on the page is its own window but shares one origin, so
// the lab's usual habits would leak between them. This entry keeps
// each frame to itself before the lab boots.
import { installLabBridge } from "../bridge";
import { applyPose } from "../pose";
import "./demo.css";

const pose = new URLSearchParams(location.search);
const webShell = pose.get("shell") === "web";

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

applyPose();

const html = document.documentElement;
if (webShell) {
  // What web/public/boot-theme.js stamps pre-paint, by the same
  // breakpoint. AppShell keeps it in step from here.
  if (!matchMedia("(min-width: 48rem)").matches) html.dataset.layout = "phone";
} else {
  // The desktop window: transparent under the sidebar, as in the real
  // one, with the traffic lights where it puts them.
  html.dataset.shell = "desktop";
  const lights = document.createElement("div");
  lights.className = "demo-traffic-lights";
  lights.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) lights.append(document.createElement("span"));
  document.body.append(lights);
}

installLabBridge({ webShell, isDev: false });

// The desktop lab's boot: the shared renderer boot over a memory
// router, posed by ?to. The web shell takes it too, since a frame's
// path is the frame's, not a route.
void import("../boot");
