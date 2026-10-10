// The scene viewer: /scenes.html?scene=<name> on the desktop fake
// host's server draws one scene (@shigomori/ui's src/scenes) at its own size,
// with the app's own stylesheet and the layout its window takes.
// Without ?scene it lists them. The appearance poses apply (pose.ts:
// ?theme, ?doubutsu, ?light, ?dark).
import { createRoot } from "react-dom/client";
import "./scenes.css";
import "@shigomori/ui/styles/fonts.css";
import { windowShell } from "@shigomori/ui/scenes/frame.tsx";
import { type Scene, scenes } from "@shigomori/ui/scenes/index.ts";
import { ThemeRootProvider } from "@shigomori/ui/root.tsx";
import { applyPose } from "./pose";

applyPose();
const root = document.getElementById("root");
if (!root) throw new Error("#root missing from scenes.html");
// A desktop scene's page is transparent under its sidebar, so the
// browser's canvas shows there, and follows the theme.
document.documentElement.style.colorScheme = root.style.colorScheme;
const name = new URLSearchParams(location.search).get("scene");
const scene: Scene | undefined = name
  ? scenes[name as keyof typeof scenes]
  : undefined;

if (scene) {
  root.dataset["shell"] = windowShell(scene.window);
  const [width, height] = scene.size;
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  createRoot(root).render(
    <ThemeRootProvider value={root}>
      <scene.Scene />
    </ThemeRootProvider>,
  );
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
