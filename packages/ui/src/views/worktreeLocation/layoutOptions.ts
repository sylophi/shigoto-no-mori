// The worktree layouts as the UI names them. Data only, so the Configure
// page's summary can name the saved layout without pulling the location
// form into its chunk.
import type { DeviceLayoutInputs } from "@shigomori/contracts/git/worktreeLayout";
import type { WorktreeLayout } from "@shigomori/contracts/schemas/index";

// What a device's layout previews are drawn from: its paths and its
// settings, with its home folder to spell paths under. The app's
// useDeviceLayout reads it.
export type DeviceLayout = DeviceLayoutInputs & { homedir: string };

export interface LayoutOption {
  value: WorktreeLayout;
  label: string;
  description?: string;
  recommended?: boolean;
}

export const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    value: "managed-root",
    label: "Managed",
    description: "Worktrees live in Shigomori's data folder.",
    recommended: true,
  },
  {
    value: "in-project",
    label: "In project",
    description: "Worktrees live inside the primary at .shigomori/wt/.",
  },
  {
    value: "custom",
    label: "Custom path",
  },
];
