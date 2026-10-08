import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { useNow } from "@/hooks/ui/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import {
  worktreeLastActivityAt,
  type Project,
  type PullRequest,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { ActivityIcon } from "../ActivityIcon";
import {
  MirrorBadge,
  RowDeviceBadge,
  type SidebarDeviceBadge,
} from "../DeviceBadge";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { ProjectMenuItems, useProjectMenuRemoveArm } from "../ProjectMenuItems";
import type { StackPosition } from "@shared/pullRequestStack";
import {
  activityMark,
  useWorktreeRowState,
  type WorktreeRowState,
} from "../useWorktreeRowState";
import { WorktreeEntry } from "../WorktreeEntry";
import type { InboxShelf } from "../sidebarRow";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface InboxRowProps {
  worktree: Worktree;
  project: Project;
  pr: PullRequest | undefined;
  stack: StackPosition | null;
  // The peer this worktree lives on, or undefined for this machine's own.
  device: SidebarDeviceBadge | undefined;
  mirror?: SidebarDeviceBadge;
  mirrorWorktreeId?: string;
  shelf: InboxShelf | null;
}

// The inbox row answers a different question from the tree row. In the
// tree you already know the project, so its row is this one without
// the project line. Here every row comes from somewhere else and you're
// triaging: which repo, which branch, what state it's in, and when it
// last moved. The row itself is the tree's (WorktreeEntry), with the
// project and the time over it.
//
//   [icon] project                                  14m ago
//   feat/the-branch
//   [kind] dirname                             ±3  ↑2  #142
//
// Right-click opens the project's menu, the same list the tree hangs
// off a project header's `…`. The inbox has no project headers, so this
// is the only place its project-level actions can live. A peer's row
// wears its device badge beside the project name, opens under that
// device's route, and scopes that menu to the peer. Asleep, it keeps the
// row (last known state) and drops the menu, since there is no session
// to act over.
export function InboxRow({
  worktree,
  project,
  pr,
  stack,
  device,
  mirror,
  mirrorWorktreeId,
  shelf,
}: InboxRowProps) {
  const state = useWorktreeRowState(worktree, device?.deviceId, {
    deviceId: mirror?.deviceId,
    worktreeId: mirrorWorktreeId,
  });
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  const peerApi = useRemoteDeviceApi(device?.deviceId);

  // An element for the trigger to `render`, so it wraps no extra div.
  const row = (
    <WorktreeEntry
      worktree={worktree}
      pr={pr}
      stack={stack}
      device={device}
      mirror={mirror}
      state={state}
      shelf={shelf}
      context={
        <div className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
          <ProjectIcon
            projectId={worktree.projectId}
            name={project.name}
            deviceId={device?.deviceId}
            className="size-3"
          />
          <SimpleTooltip whenTruncated tip={project.name}>
            <span className="min-w-0 truncate font-medium">{project.name}</span>
          </SimpleTooltip>
          {device && <RowDeviceBadge badge={device} />}
          {mirror && <MirrorBadge mirror={mirror} />}
          <TrailingSlot worktree={worktree} state={state} />
        </div>
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

// Right end of the context line: normally "when did this last move",
// which is what the inbox sorts on. A running script or a delete in
// flight displaces it. Those are happening now, so they outrank a
// timestamp.
function TrailingSlot({
  worktree,
  state,
}: {
  worktree: Worktree;
  state: WorktreeRowState;
}) {
  const mark = activityMark(state);
  const activityAt = worktreeLastActivityAt(worktree);
  const now = useNow();

  return (
    <span className="ml-auto flex shrink-0 items-center">
      {mark ? (
        <ActivityIcon kind={mark} />
      ) : (
        <span className="tabular">
          {activityAt > 0 ? formatRelativeTime(activityAt, now) : "no activity"}
        </span>
      )}
    </span>
  );
}
