// The scene viewer: /scenes.html?scene=<name> on the desktop fake
// host's server draws one scene (@shigomori/ui's src/scenes) at its own size,
// with the app's own stylesheet and the layout its window takes.
// Without ?scene it lists them. The appearance poses apply (pose.ts:
// ?theme, ?doubutsu, ?light, ?dark).
import { createRoot } from "react-dom/client";
import "./scenes.css";
import "@shigomori/ui/styles/fonts.css";
import { windowAttributes } from "@shigomori/ui/scenes/frame.tsx";
import { type Scene, scenes } from "@shigomori/ui/scenes/index.ts";
import { applyPose } from "./pose";

applyPose();
delete document.documentElement.dataset["layout"];
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
