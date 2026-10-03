// Every scene, by name: what test/scenes.mts renders to prove each one
// still renders without the app, and what the marketing site shows.
import {
  DetailBadgerScene,
  DetailHummingbirdScene,
  LaunchRowScene,
} from "./DetailScene";
import { DevicesScene } from "./DevicesScene";
import { RowScene } from "./RowScene";
import {
  NewWorktreeMenuScene,
  PhoneScene,
  SidebarInboxScene,
  SidebarTreeScene,
} from "./SidebarScenes";
import { TransplantScene } from "./TransplantScene";

export const scenes = {
  row: RowScene,
  sidebarInbox: SidebarInboxScene,
  sidebarTree: SidebarTreeScene,
  newWorktreeMenu: NewWorktreeMenuScene,
  phone: PhoneScene,
  detailHummingbird: DetailHummingbirdScene,
  detailBadger: DetailBadgerScene,
  launchRow: LaunchRowScene,
  devices: DevicesScene,
  transplant: TransplantScene,
};
