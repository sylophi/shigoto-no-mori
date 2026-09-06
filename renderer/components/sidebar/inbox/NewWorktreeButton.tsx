import { Folder, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MaybeHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { useQuickCreateWorktree } from "@/hooks/worktrees/useQuickCreateWorktree";
import type { Project } from "@shared/schemas";
import { deviceBadgeOf } from "../buildSidebarRows";
import { DeviceBadge, type SidebarDeviceBadge } from "../DeviceBadge";
import { ProjectIcon } from "../ProjectIcon";

interface NewWorktreeButtonProps {
  projects: Project[];
  // Peers' forests, so a project that lives only on another machine
  // (or on this one and others) can be created into from here.
  remote: RemoteForestItem[];
}

// Somewhere a worktree can be created: this machine's project, or a
// peer's, carrying the scope its create runs under.
interface CreateTarget {
  key: string;
  project: Project;
  // Absent for a local project.
  peer: { api: HostApi; badge: SidebarDeviceBadge } | undefined;
}

// The inbox view's create affordance. Classic view hangs a + off each
// project header. The inbox has none, so the destination has to be
// picked here: one target means there's nothing to pick and the button
// creates outright, several open a menu. A peer's project is a target
// like a local one, badged with its device. A peer that is asleep or
// has not granted this device control is left out, since its create
// would only be refused. Either way a
// modified click lands on the full form instead of quick-creating,
// matching the project row's + button.
export function NewWorktreeButton({
  projects,
  remote,
}: NewWorktreeButtonProps) {
  const registry = useRemoteDevices();
  const access = usePeerCommandAccess(registry);
  const targets: CreateTarget[] = [
    ...projects
      .filter((project) => project.pathExists !== false)
      .map((project) => ({ key: project.id, project, peer: undefined })),
    ...remote.flatMap((item) => {
      const api = registry.find(
        (device) => device.deviceId === item.deviceId,
      )?.api;
      if (
        api === undefined ||
        !commandAccessOf(access, item.deviceId).canCommand
      ) {
        return [];
      }
      return [
        {
          key: `${item.deviceId}/${item.project.id}`,
          project: item.project,
          peer: { api, badge: deviceBadgeOf(item) },
        },
      ];
    }),
  ];

  // Nothing to pick between: create outright, or sit disabled with no
  // menu behind it when there's nowhere to create at all.
  if (targets.length <= 1) {
    const only = targets[0];
    if (only === undefined) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled
          title="Nowhere to create a worktree yet"
          className="w-full"
        >
          <Plus aria-hidden />
          New worktree
        </Button>
      );
    }
    return (
      <MaybeHostScope
        deviceId={only.peer?.badge.deviceId ?? ""}
        api={only.peer?.api}
      >
        <SingleTargetButton target={only} />
      </MaybeHostScope>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label="New worktree"
            className="w-full"
          >
            <Plus aria-hidden />
            New worktree
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4}>
        {/* GroupLabel throws outside a Group -- Base UI reads the group
            context to wire the label to the items it names. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            New worktree in… (⇧ to pick a base)
          </DropdownMenuLabel>
          {targets.map((target) => (
            <MaybeHostScope
              key={target.key}
              deviceId={target.peer?.badge.deviceId ?? ""}
              api={target.peer?.api}
            >
              <TargetItem target={target} />
            </MaybeHostScope>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SingleTargetButton({ target }: { target: CreateTarget }) {
  const { createFrom, isPending } = useQuickCreateWorktree();
  const where = target.peer
    ? `${target.project.name} on ${target.peer.badge.label}`
    : target.project.name;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending}
      aria-busy={isPending}
      title={`New worktree in ${where} (hold ⇧ to pick a base)`}
      onClick={(event) => createFrom(event, target.project.id)}
      className="w-full"
    >
      {isPending ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : (
        <Plus aria-hidden />
      )}
      {isPending ? "Creating worktree…" : "New worktree"}
    </Button>
  );
}

// One per target: each sits under its own scope, so each needs the
// create hook bound to that scope.
function TargetItem({ target }: { target: CreateTarget }) {
  const { createFrom, isPending } = useQuickCreateWorktree();
  return (
    <DropdownMenuItem
      disabled={isPending}
      onClick={(event) => createFrom(event, target.project.id)}
    >
      {/* Fallback so every row is icon-then-name: without it the
          projects with no detected icon start at a different x
          and the menu reads as two ragged columns. */}
      <ProjectIcon
        projectId={target.project.id}
        deviceId={target.peer?.badge.deviceId}
        fallback={Folder}
      />
      {target.project.name}
      {target.peer && <DeviceBadge badge={target.peer.badge} />}
    </DropdownMenuItem>
  );
}
