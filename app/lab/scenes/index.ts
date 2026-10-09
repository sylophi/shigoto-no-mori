// Every scene, by name: a picture of the app, drawn by its own views
// over the fake host's fixtures. The marketing site shows them, the
// viewer (../fake-host/scenes.html) draws one at a time, and
// test/scenes.mts renders each to prove it still needs no app, and that
// every view is in one.
import type { ComponentType } from "react";
import type { SceneWindow } from "./frame";
import {
  FolderPickerScene,
  MarksScene,
  MissingWorktreeScene,
  PathPickerScene,
  PeerProjectPageScene,
  ProjectPageScene,
} from "./shared";
import {
  CrashScene,
  FirstRunScene,
  ForestPageScene,
  PhoneInboxScene,
  PhoneNotFoundScene,
} from "./shell";
import { SidebarPartsScene } from "./sidebarParts";
import {
  WorktreePagePartsScene,
  WorktreePageScene,
  WorktreeSectionsScene,
} from "./worktreePage";

export interface Scene {
  // Takes no props: a scene is one picture.
  Scene: ComponentType;
  // The size it lays out at, in CSS pixels: the window it draws, or
  // what a part comes to at the width it is given.
  size: readonly [width: number, height: number];
  // The window it draws a whole one of. Unset for a part.
  window?: SceneWindow;
}

// The desktop window's default size (main/index.ts), and a phone's.
const DESKTOP = { size: [920, 720], window: "desktop" } as const;
const PHONE = { size: [390, 844], window: "phone" } as const;

export const scenes = {
  firstRun: { Scene: FirstRunScene, ...DESKTOP },
  forestPage: { Scene: ForestPageScene, ...DESKTOP },
  phoneNotFound: { Scene: PhoneNotFoundScene, ...PHONE },
  phoneInbox: { Scene: PhoneInboxScene, ...PHONE },
  sidebarParts: { Scene: SidebarPartsScene, size: [920, 560] },
  worktreePage: { Scene: WorktreePageScene, ...DESKTOP },
  worktreePageParts: { Scene: WorktreePagePartsScene, size: [1100, 900] },
  worktreeSections: { Scene: WorktreeSectionsScene, size: [1400, 1000] },
  crash: { Scene: CrashScene, size: [480, 360] },
  projectPage: { Scene: ProjectPageScene, ...DESKTOP },
  peerProjectPage: { Scene: PeerProjectPageScene, ...DESKTOP },
  missingWorktree: { Scene: MissingWorktreeScene, ...DESKTOP },
  marks: { Scene: MarksScene, size: [640, 420] },
  folderPicker: { Scene: FolderPickerScene, ...DESKTOP },
  pathPicker: { Scene: PathPickerScene, ...DESKTOP },
} satisfies Record<string, Scene>;
