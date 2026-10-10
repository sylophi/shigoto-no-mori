import { LAYOUT_OPTIONS } from "@shigomori/ui/views/worktreeLocation/layoutOptions.ts";
import { useDeviceLayout } from "@/hooks/config/useDeviceLayout";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { managedDriveBaseFor } from "@shigomori/contracts/git/worktreeLayout";
import {
  PROJECT_CONFIG_DEFAULTS,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { WorktreeLocationFieldView } from "@shigomori/ui/views/configure/WorktreeLocationFieldView.tsx";

// The project's worktree location (WorktreeLocationFieldView), off the
// saved config and this device's layout.
export function WorktreeLocationField({
  projectId,
  projectPath,
  config,
  home,
  blocked,
}: {
  projectId: string;
  projectPath: string;
  config: ShigomoriConfig | null;
  home: string | null;
  // The form around it has unsaved edits, which leaving for the
  // subpage would throw away.
  blocked: boolean;
}) {
  const { toProjectPage } = useProjectNav();
  const device = useDeviceLayout();
  const layout =
    config?.worktreeLayout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout;
  const option = LAYOUT_OPTIONS.find((o) => o.value === layout);
  // A custom layout has no description. Its folder says more, and so
  // does the one the managed layout keeps on the project's drive.
  const customPath =
    layout === "custom" ? config?.customWorktreePath?.trim() : undefined;
  const drivePath =
    layout === "managed-root" && device
      ? managedDriveBaseFor(projectPath, device)
      : null;

  return (
    <WorktreeLocationFieldView
      label={option?.label}
      description={option?.description}
      shownPath={customPath || drivePath}
      home={home}
      blocked={blocked}
      onChange={() => toProjectPage("worktreeLocation", projectId)}
    />
  );
}
