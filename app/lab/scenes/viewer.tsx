// The scene viewer: /scenes.html?scene=<name> on the lab's server draws
// one scene (lab/scenes/index.ts) with the app's own stylesheet, for a
// look at it beside the live lab (lab/shoot.mts shoots it like any
// pose). Without ?scene it lists them. The lab's appearance poses apply
// (?theme, ?doubutsu, ?light, ?dark), plus ?phone=1 for the phone layout
// and ?desktop=1 for the desktop window's transparent page.
import { createRoot } from "react-dom/client";
import "@/index.css";
import "@/fonts.css";
import { applyPose } from "../pose";
import { scenes } from "./index";

applyPose();
const pose = new URLSearchParams(location.search);
const html = document.documentElement;
if (pose.get("phone") === "1") html.dataset["layout"] = "phone";
if (pose.get("desktop") === "1") html.dataset["shell"] = "desktop";

const name = pose.get("scene");
const Scene = name ? scenes[name as keyof typeof scenes] : undefined;
const root = document.getElementById("root");
if (!root) throw new Error("#root missing from scenes.html");
// The viewport, which a window scene fills (h-full).
root.style.height = "100dvh";

createRoot(root).render(
  Scene ? (
    <Scene />
  ) : (
    <ul className="p-6 text-sm">
      {Object.keys(scenes).map((scene) => (
        <li key={scene}>
          <a className="underline" href={`?scene=${scene}`}>
            {scene}
          </a>
        </li>
      ))}
    </ul>
  ),
);
