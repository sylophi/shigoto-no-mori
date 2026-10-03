// The live app frames on shigomori.com (marketing/README.md): the lab
// on its fixture bridge, built for the web and embedded in iframes,
// one per pose. The poses ride the URL as they do in the lab
// (lab/README.md), plus:
//   ?shell=web   the web shell, which under 768px wide is the phone
//                layout. Absent, the desktop window.
//
// Every frame on the page is its own window but shares one origin, so
// the lab's usual habits would leak between them: isolate.ts keeps each
// frame to itself, before any lab module loads.
// oxlint-disable-next-line import/no-unassigned-import -- its body must run before any lab module loads, so it can't wait to be called
import "./isolate";
import { installLabBridge } from "../bridge";
import { applyPose } from "../pose";
import "./demo.css";

const pose = new URLSearchParams(location.search);
const webShell = pose.get("shell") === "web";

applyPose();

const html = document.documentElement;
if (webShell) {
  // What web/public/boot-theme.js stamps pre-paint, by the same
  // breakpoint (renderer/hooks/ui/useViewport.ts's). AppShell keeps it
  // in step from here.
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
