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
import { DevicesPageScene, DevicesPartsScene } from "./devices";
import {
  SettingsAppearanceScene,
  SettingsDialogsScene,
  SettingsGeneralScene,
  SettingsPartsScene,
} from "./settings";
import { VillagersPartsScene, VisitorsScene } from "./villagers";
import {
  FlowPartsScene,
  FlowStepsScene,
  MirrorManageScene,
  MirrorReviewScene,
  TransplantReviewScene,
} from "./flows";
import {
  ConfigureScene,
  HomeEmptyScene,
  HomeScene,
  ProjectPagesPartsScene,
  TidyScene,
} from "./projectPages";
import {
  AddProjectPartsScene,
  AddProjectScene,
  NewWorktreeBranchScene,
  NewWorktreeScene,
} from "./newCheckouts";
import { ChangesPageScene, CommitPageScene, DiffPartsScene } from "./diffPages";
import { FilesPageScene, FilesPartsScene } from "./files";
import { LivePageScene, LiveQuietScene } from "./live";
import { PalettePickedScene, PaletteScene } from "./palette";
import { PullRequestPartsScene } from "./pullRequests";
import { SidebarPartsScene } from "./sidebarParts";
import { TerminalPartsScene } from "./terminal";
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
  pullRequestParts: { Scene: PullRequestPartsScene, size: [1100, 1300] },
  transplantReview: { Scene: TransplantReviewScene, size: [960, 780] },
  mirrorReview: { Scene: MirrorReviewScene, size: [960, 640] },
  flowSteps: { Scene: FlowStepsScene, size: [1800, 1300] },
  mirrorManage: { Scene: MirrorManageScene, size: [1600, 720] },
  flowParts: { Scene: FlowPartsScene, size: [1100, 800] },
  devicesPage: { Scene: DevicesPageScene, ...DESKTOP },
  devicesParts: { Scene: DevicesPartsScene, size: [1200, 1500] },
  settingsGeneral: { Scene: SettingsGeneralScene, ...DESKTOP },
  settingsAppearance: { Scene: SettingsAppearanceScene, ...DESKTOP },
  settingsParts: { Scene: SettingsPartsScene, size: [1200, 2050] },
  settingsDialogs: { Scene: SettingsDialogsScene, size: [1500, 900] },
  visitors: { Scene: VisitorsScene, ...DESKTOP },
  villagersParts: { Scene: VillagersPartsScene, size: [1200, 1100] },
  configure: { Scene: ConfigureScene, ...DESKTOP },
  projectPagesParts: { Scene: ProjectPagesPartsScene, size: [1300, 1700] },
  tidy: { Scene: TidyScene, ...DESKTOP },
  home: { Scene: HomeScene, ...DESKTOP },
  homeEmpty: { Scene: HomeEmptyScene, size: [700, 300] },
  newWorktree: { Scene: NewWorktreeScene, ...DESKTOP },
  newWorktreeBranch: { Scene: NewWorktreeBranchScene, ...DESKTOP },
  addProject: { Scene: AddProjectScene, ...DESKTOP },
  addProjectParts: { Scene: AddProjectPartsScene, size: [1300, 1500] },
  changesPage: { Scene: ChangesPageScene, ...DESKTOP },
  commitPage: { Scene: CommitPageScene, ...DESKTOP },
  diffParts: { Scene: DiffPartsScene, size: [1300, 900] },
  filesPage: { Scene: FilesPageScene, ...DESKTOP },
  filesParts: { Scene: FilesPartsScene, size: [900, 700] },
  livePage: { Scene: LivePageScene, size: [1300, 900], window: "desktop" },
  liveQuiet: { Scene: LiveQuietScene, ...DESKTOP },
  palette: { Scene: PaletteScene, ...DESKTOP },
  palettePicked: { Scene: PalettePickedScene, ...DESKTOP },
  crash: { Scene: CrashScene, size: [480, 360] },
  projectPage: { Scene: ProjectPageScene, ...DESKTOP },
  peerProjectPage: { Scene: PeerProjectPageScene, ...DESKTOP },
  missingWorktree: { Scene: MissingWorktreeScene, ...DESKTOP },
  marks: { Scene: MarksScene, size: [640, 420] },
  folderPicker: { Scene: FolderPickerScene, ...DESKTOP },
  pathPicker: { Scene: PathPickerScene, ...DESKTOP },
  terminalParts: { Scene: TerminalPartsScene, size: [1100, 720] },
} satisfies Record<string, Scene>;
