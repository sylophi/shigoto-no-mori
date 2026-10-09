// The inbox's row (InboxRowView), with the project's menu on a right
// click. A peer's row scopes that menu to the peer. Asleep, or taking
// no commands from here, it keeps the row (last known state) and drops
// the menu, as the tree's project header drops its actions.
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCommandableDeviceApi } from "@/hooks/remote/useCommandAccess";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { ProjectMenuItems, useProjectMenuRemoveArm } from "../ProjectMenuItems";
import { useWorktreeEntry } from "../useWorktreeEntry";
import { type InboxRowProps, InboxRowView } from "./InboxRowView";

export function InboxRow({ mirrorWorktreeId, ...props }: InboxRowProps) {
  const { worktree, project, device, mirror } = props;
  const entry = useWorktreeEntry(worktree, device, {
    deviceId: mirror?.deviceId,
    worktreeId: mirrorWorktreeId,
  });
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  const peerApi = useCommandableDeviceApi(device?.deviceId);

  // An element for the trigger to `render`, so it wraps no extra div.
  const row = (
    <InboxRowView
      {...props}
      entry={entry}
      projectIcon={
        <ProjectIcon
          projectId={worktree.projectId}
          name={project.name}
          deviceId={device?.deviceId}
          className="size-3"
        />
      }
    />
  );

  if (device !== undefined && peerApi === undefined) return row;
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <MaybeHostScope deviceId={device?.deviceId ?? ""} api={peerApi}>
          <ProjectMenuItems
            project={project}
            subject="worktree"
            removeArm={removeArm}
          />
        </MaybeHostScope>
      </ContextMenuContent>
    </ContextMenu>
  );
}
