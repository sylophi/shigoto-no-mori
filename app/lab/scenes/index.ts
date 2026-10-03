// Every scene, by name: a picture of the app, drawn by its own views
// over the lab's fixtures. The marketing site shows them, the viewer
// (viewer.tsx) draws one at a time beside the live lab, and
// test/scenes.mts renders each to prove it still needs no app.
import type { ComponentType } from "react";
import { LaunchRowScene, RowScene } from "./PartScenes";
import { TransplantScene } from "./TransplantScene";
import {
  CreateWindowScene,
  DevicesWindowScene,
  HeroWindowScene,
  PhoneWindowScene,
  StackWindowScene,
} from "./WindowScenes";

// A whole window a scene can draw: the desktop app's, or the web app
// on a phone.
export type SceneWindow = "desktop" | "phone";

export interface Scene {
  // Takes no props: a scene is one picture.
  Scene: ComponentType;
  // The size it lays out at, in CSS pixels: the window it draws, or
  // what a part comes to at the width it is given.
  size: readonly [width: number, height: number];
  // The window it draws a whole one of. Unset for a part.
  window?: SceneWindow;
}

// What the app's stylesheet reads off <html> to lay a window out
// (data-shell, data-layout), for whoever stands in for <html> around a
// scene: the desktop window's page is transparent under the sidebar,
// and the phone takes the phone layout.
export function windowAttributes(window: SceneWindow | undefined): {
  "data-shell"?: "desktop";
  "data-layout"?: "phone";
} {
  if (window === "desktop") return { "data-shell": "desktop" };
  if (window === "phone") return { "data-layout": "phone" };
  return {};
}

const DESKTOP = { size: [1280, 800], window: "desktop" } as const;

export const scenes = {
  heroWindow: { Scene: HeroWindowScene, ...DESKTOP },
  stackWindow: { Scene: StackWindowScene, ...DESKTOP },
  createWindow: { Scene: CreateWindowScene, ...DESKTOP },
  devicesWindow: { Scene: DevicesWindowScene, ...DESKTOP },
  phoneWindow: { Scene: PhoneWindowScene, size: [390, 844], window: "phone" },
  row: { Scene: RowScene, size: [240, 63] },
  launchRow: { Scene: LaunchRowScene, size: [600, 140] },
  transplant: { Scene: TransplantScene, size: [896, 633] },
} satisfies Record<string, Scene>;
