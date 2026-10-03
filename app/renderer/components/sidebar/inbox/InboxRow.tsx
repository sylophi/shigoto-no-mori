import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { useNow } from "@/hooks/ui/useNow";
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import type { StackPosition } from "@shared/pullRequestStack";
import type { SidebarDeviceBadge } from "../DeviceBadge";
import { ProjectMenuItems, useProjectMenuRemoveArm } from "../ProjectMenuItems";
import type { InboxShelf } from "../sidebarRow";
import { useWorktreeEntry } from "../useWorktreeEntry";
import { ActivityAgeView, InboxRowView } from "./InboxRowView";

interface InboxRowProps {
  worktree: Worktree;
  project: Project;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // The peer this worktree lives on, or undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  mirror?: SidebarDeviceBadge;
  shelf: InboxShelf | null;
}

// An inbox row (InboxRowView), with its state and what it looks up.
//
// Right-click opens the project's menu, the same list the tree hangs
// off a project header's `…`. The inbox has no project headers, so this
// is the only place its project-level actions can live. A peer's row
// opens under that device's route and scopes that menu to the peer.
// Asleep, it keeps the row (last known state) and drops the menu, since
// there is no session to act over.
export function InboxRow({
  worktree,
  project,
  pr,
  stack,
  device,
  mirror,
  shelf,
}: InboxRowProps) {
  const entry = useWorktreeEntry(worktree, device?.deviceId);
  const projectIconSrc = useProjectIcon(worktree.projectId, device?.deviceId);
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  const peerApi = useRemoteDeviceApi(device?.deviceId);

  // An element for the trigger to `render`, so it wraps no extra div.
  const row = (
    <InboxRowView
      worktree={worktree}
      project={project}
      projectIconSrc={projectIconSrc}
      age={<ActivityAge worktree={worktree} />}
      pr={pr}
      stack={stack}
      device={device}
      mirror={mirror}
      shelf={shelf}
      {...entry}
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

// The row's age, a leaf of its own on the shared clock, so a tick
// redraws this and not the row.
function ActivityAge({ worktree }: { worktree: Worktree }) {
  return <ActivityAgeView worktree={worktree} now={useNow()} />;
}
