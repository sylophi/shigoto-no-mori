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

export interface Scene {
  // Takes no props: a scene is one picture.
  Scene: ComponentType;
  // The size it lays out at, in CSS pixels: the window it draws, or
  // what a part comes to at the width it is given.
  size: readonly [width: number, height: number];
  // What it draws a whole window of, which sets the layout the app's
  // stylesheet gives it: the desktop app's window (its page transparent
  // under the sidebar) or the web app on a phone. Unset for a part.
  window?: "desktop" | "phone";
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
