// The inbox's row (InboxRowView), with the worktree's menu on a right
// click (WorktreeMenu), led by the way to its project. A peer's row
// scopes that menu to the peer. Asleep, or taking no commands from
// here, it keeps the row (last known state) and the menu only what
// reads it.
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useWorktreeEntry } from "../useWorktreeEntry";
import { WorktreeMenu } from "../WorktreeMenu";
import {
  type InboxRowProps,
  InboxRowView,
} from "@shigomori/ui/views/sidebar/inbox/InboxRowView.tsx";

export function InboxRow({
  deviceId,
  mirrorWorktreeId,
  ...props
}: InboxRowProps & { deviceId: string }) {
  const { worktree, project, pr } = props;
  const entry = useWorktreeEntry({ ...props, deviceId, mirrorWorktreeId });
  return (
    <WorktreeMenu
      worktree={worktree}
      pr={pr}
      deviceId={deviceId}
      project={project}
      row={
        <InboxRowView
          {...props}
          entry={entry}
          projectIcon={
            <ProjectIcon
              projectId={worktree.projectId}
              name={project.name}
              deviceId={deviceId}
              className="size-3"
            />
          }
        />
      }
    />
  );
}
