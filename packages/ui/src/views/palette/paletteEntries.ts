// What the palette lists, as the app's buildPaletteEntries.ts and
// PaletteRows.tsx build it for the views.
import type { LucideIcon } from "lucide-react";
import type {
  Project,
  PullRequest,
  Worktree,
} from "@shigomori/contracts/schemas";
import type { SidebarDeviceBadge } from "../sidebar/DeviceBadgeView.tsx";

// One worktree the palette can land on, wherever it lives.
export interface PaletteEntry {
  // The sidebar's own row key, so a worktree has one identity in both.
  key: string;
  worktree: Worktree;
  project: Project;
  // The peer it lives on. Undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  // The peer a local worktree is mirrored with (its peer row folds in).
  mirror: SidebarDeviceBadge | undefined;
  // The pull request open (or once open) for its branch.
  pr: PullRequest | undefined;
  // Matches a hidden-worktree prefix: listed only for a query.
  hidden: boolean;
  // Merged, shelved or agent working: still found, but below the work in
  // progress.
  sunk: boolean;
}

// A project the query names, standing for its checkouts on every
// device: one row per sidebar group, however many machines hold it.
export interface PaletteProject {
  key: string;
  // The checkout the row names: this device's when it has one.
  project: Project;
  // The peer that checkout is on. Undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  // Where ↩ goes: its worktree the list would put first. Undefined
  // for a project with none, whose ↩ is its new-worktree page.
  lead: PaletteEntry | undefined;
  // This device's checkout, when it has one: where a quick create goes.
  localProject: Project | undefined;
  worktreeCount: number;
  deviceCount: number;
}

// A page of the app the query names: one the sidebar's footer leads to,
// or a section of Settings.
export interface PalettePage {
  key: string;
  label: string;
  icon: LucideIcon;
  // Settings, for a section of it: where the row says it is, and what
  // the query can name it by too ("settings appearance").
  parent?: string;
  // What else it goes by ("Devices" for the account).
  aliases?: readonly string[];
  open: () => void;
}

// Everything the list can hold: the worktrees, the projects and pages a
// query names, and, for a query, the worktree it could make.
export type PaletteRow =
  | { kind: "worktree"; key: string; entry: PaletteEntry }
  | { kind: "project"; key: string; item: PaletteProject }
  | { kind: "page"; key: string; page: PalettePage }
  | {
      kind: "create";
      key: string;
      branch: string;
      // Where it can go, the one ↩ picks first.
      targets: [Project, ...Project[]];
    };
