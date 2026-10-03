// Every scene, by name: what test/scenes.mts renders to prove each one
// still renders without the app, and what the marketing site shows.
import { RowScene } from "./RowScene";
import {
  NewWorktreeMenuScene,
  PhoneScene,
  SidebarInboxScene,
  SidebarTreeScene,
} from "./SidebarScenes";

export const scenes = {
  row: RowScene,
  sidebarInbox: SidebarInboxScene,
  sidebarTree: SidebarTreeScene,
  newWorktreeMenu: NewWorktreeMenuScene,
  phone: PhoneScene,
};
