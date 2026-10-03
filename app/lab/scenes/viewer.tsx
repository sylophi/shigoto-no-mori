// The scene viewer: /scenes.html?scene=<name> on the lab's server draws
// one scene (lab/scenes/index.ts) at its own size, with the app's own
// stylesheet and the layout its window takes, for a look at it beside
// the live lab (lab/shoot.mts shoots it like any pose). Without ?scene
// it lists them. The lab's appearance poses apply (?theme, ?doubutsu,
// ?light, ?dark).
import { createRoot } from "react-dom/client";
import "@/index.css";
import "@/fonts.css";
import { applyPose } from "../pose";
import { type Scene, scenes, windowAttributes } from "./index";

applyPose();
const name = new URLSearchParams(location.search).get("scene");
const scene: Scene | undefined = name
  ? scenes[name as keyof typeof scenes]
  : undefined;
const root = document.getElementById("root");
if (!root) throw new Error("#root missing from scenes.html");

if (scene) {
  for (const [attribute, value] of Object.entries(
    windowAttributes(scene.window),
  )) {
    document.documentElement.setAttribute(attribute, value);
  }
  const [width, height] = scene.size;
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  createRoot(root).render(<scene.Scene />);
} else {
  createRoot(root).render(
    <ul className="p-6 text-sm">
      {Object.keys(scenes).map((key) => (
        <li key={key}>
          <a className="underline" href={`?scene=${key}`}>
            {key}
          </a>
        </li>
      ))}
    </ul>,
  );
}
