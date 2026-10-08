// The `+` and `…` a project header wears, for a group that may span
// several devices: this machine's checkout with the peers' merged into
// it, or the peers' alone. Every member is a (device, project) pair
// with the api its actions run over, and each action mounts under a
// member's scope so quick create, the form and every menu page land on
// the right device with no remote-awareness of their own.
//
// The `+` creates instantly, on the group's designated device
// (useQuickCreateDeviceId, picked on the Configure page) when it is
// live, else the first live member, this machine first. The `…` is one
// action list however many devices the group spans: its create pair
// follows the `+`, and the pages open for this machine's copy (the
// `+`'s device on a header with no local checkout). Every page carries
// a device tab bar (ProjectDevicePage), so the menu offers no device
// choice of its own, save for two entries with no page to make the
// choice on, which open a submenu naming devices instead: Remove, on a
// group spanning devices, names each member, and Add to device names
// the machines that don't hold the repo yet (AddToDeviceSubmenu). A
// member with no session gets no actions, the same as a missing local
// project.
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { useLocalDevice } from "@/hooks/account/useAccount";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { useCommandableApi } from "@/hooks/remote/useCommandAccess";
import { useSetProjectPinned } from "@/hooks/sharedSettings/usePinnedProjects";
import { useQuickCreateDeviceId } from "@/hooks/sharedSettings/useQuickCreateDevice";
import { MaybeHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";
import { AddToDeviceSubmenu } from "./AddToDeviceSubmenu";
import {
  ProjectCreateMenuItems,
  ProjectPageMenuItems,
  ProjectRemoveMenuItem,
  useProjectMenuRemoveArm,
  type ProjectMenuRemoveArm,
} from "./ProjectMenuItems";
import { QuickCreateButton } from "./QuickCreateButton";
import {
  PROJECT_ACTION_HOOKS,
  PROJECT_MENU_TRIGGER_CLASS,
} from "./sidebarChrome";
import type { RemoteProjectMember } from "./sidebarRow";

export interface GroupMember {
  deviceId: string;
  deviceLabel: string;
  deviceIcon: DeviceIcon;
  project: Project;
  // Undefined while the device has no session (a peer that is asleep),
  // or while it has not granted this device control: either way its
  // actions would only be refused.
  api: HostApi | undefined;
  isThisDevice: boolean;
}

export type LiveMember = GroupMember & { api: HostApi };

// The group as the actions see it: this machine's checkout first when
// there is one, then every peer's with the api its session provides,
// where that peer lets this device command it (the same reading the
// new-worktree picker uses, and until its session reports the peer is
// assumed granted rather than flashing actions in and out).
export function useGroupMembers(
  peers: readonly RemoteProjectMember[],
  localProject: Project | undefined,
): GroupMember[] {
  const local = useLocalDevice();
  const commandableApi = useCommandableApi();
  const apis = peers.map((member) => commandableApi(member.deviceId));
  return [
    ...(localProject === undefined
      ? []
      : [
          {
            deviceId: localDeviceId,
            deviceLabel: local.name,
            deviceIcon: local.icon,
            project: localProject,
            api: window.api,
            isThisDevice: true,
          },
        ]),
    ...peers.map((member, i) => ({
      ...member,
      api: apis[i],
      isThisDevice: false,
    })),
  ];
}

// Whose icon a peer-only project shows: the repo's own, read from the
// first live member (projects:icon sits on the ungated read surface, so
// a read-only peer serves it). When every member is asleep the row
// keeps reading the member that last served it, because that is the
// key the cached icon lives under. A group that never had a live member
// reads its first. Undefined for a local project, which reads its own.
export function useIconMember(
  group: readonly GroupMember[],
  local: boolean,
): GroupMember | undefined {
  const live = local
    ? undefined
    : group.find((member) => member.api !== undefined);
  // Kept by device id: the members are rebuilt every render.
  const [lastLiveId, setLastLiveId] = useState(live?.deviceId);
  if (live !== undefined && live.deviceId !== lastLiveId) {
    setLastLiveId(live.deviceId);
  }
  if (local) return undefined;
  return (
    live ?? group.find((member) => member.deviceId === lastLiveId) ?? group[0]
  );
}

// Where the group's quick create lands: the pick (useQuickCreateDeviceId)
// when it can take one, else the first live member (this machine leads
// the list when it is one). A missing local checkout can't take a
// create either. Shared by the `+` and the inbox's New worktree menu,
// so the two land on the same device.
export function useGroupCreator(
  members: readonly GroupMember[],
  identity: string | null | undefined,
): LiveMember | undefined {
  const designatedId = useQuickCreateDeviceId(identity);
  const canCreate = members.filter(
    (member): member is LiveMember =>
      member.api !== undefined && member.project.pathExists !== false,
  );
  return (
    canCreate.find((member) => member.deviceId === designatedId) ?? canCreate[0]
  );
}

interface ProjectGroupActionsProps {
  name: string;
  // The group's repo identity, which the designation is keyed by.
  identity: string | null | undefined;
  // The group's key (projectGroupKey), which its pin is kept by.
  groupKey: string;
  pinned: boolean;
  members: readonly GroupMember[];
  isHovered: boolean;
  // The `…` trigger, so the header's right-click can pop the same menu.
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  // Set while the header's project is missing and can be located.
  onLocate?: () => void;
}

export function ProjectGroupActions({
  name,
  identity,
  groupKey,
  pinned,
  members,
  isHovered,
  triggerRef,
  onLocate,
}: ProjectGroupActionsProps) {
  const creator = useGroupCreator(members, identity);
  const setPinned = useSetProjectPinned(groupKey);
  const live = members.filter(
    (member): member is LiveMember => member.api !== undefined,
  );
  // Whose copy the pages open for (and, on a group of one, the remove
  // acts on): this machine's, or the `+`'s device on a header with no local checkout.
  const primary =
    members.find((member) => member.isThisDevice) ?? creator ?? live[0];
  // One arm for the whole menu, keyed by device in the Remove submenu.
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  const spansDevices = members.length > 1;
  // Remove lists the devices only with a copy among them to remove.
  // When every reachable one is terrier's, the plain item says so, as
  // it does for a group of one, rather than open onto all-inert rows.
  const listsRemoves =
    spansDevices && live.some((member) => member.project.source !== "terrier");
  if (primary === undefined) return null;

  return (
    <>
      {creator !== undefined && (
        <MaybeHostScope deviceId={creator.deviceId} api={creator.api}>
          <QuickCreateButton
            project={creator.project}
            isHovered={isHovered}
            deviceLabel={spansDevices ? creator.deviceLabel : undefined}
          />
        </MaybeHostScope>
      )}
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              aria-label={`More actions for ${name}`}
              {...PROJECT_ACTION_HOOKS}
              className={cn(
                PROJECT_MENU_TRIGGER_CLASS,
                isHovered ? "opacity-100" : "opacity-0",
              )}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={2}>
          {creator !== undefined && (
            <MaybeHostScope deviceId={creator.deviceId} api={creator.api}>
              <ProjectCreateMenuItems
                project={creator.project}
                subject="project"
              />
            </MaybeHostScope>
          )}
          {onLocate !== undefined && (
            <>
              <DropdownMenuItem onClick={onLocate}>Locate…</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => setPinned(!pinned)}>
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <AddToDeviceSubmenu
            name={name}
            members={members}
            onOpenChange={onOpenChange}
          />
          <MaybeHostScope deviceId={primary.deviceId} api={primary.api}>
            <ProjectPageMenuItems project={primary.project} subject="project" />
            {!listsRemoves && (
              <ProjectRemoveMenuItem
                project={primary.project}
                subject="project"
                removeArm={removeArm}
              />
            )}
          </MaybeHostScope>
          {listsRemoves && (
            <RemoveSubmenu
              members={members}
              removeArm={removeArm}
              onOpenChange={onOpenChange}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// Remove is the one entry with no page to pick a device on, so on a
// header spanning devices it opens onto the pick itself: every member
// by name, each a two-step remove of that device's copy. A member with
// no session stays listed but inert, so the list always matches the
// open header's badges, which already say it is away. Leaving the submenu
// drops a half-confirmed remove, the same as closing the menu.
function RemoveSubmenu({
  members,
  removeArm,
  onOpenChange,
}: {
  members: readonly GroupMember[];
  removeArm: ProjectMenuRemoveArm;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenuSub onOpenChange={onOpenChange}>
      <DropdownMenuSubTrigger variant="destructive">
        Remove
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {members.map((member) =>
          member.api === undefined ? (
            <DropdownMenuItem
              key={member.deviceId}
              variant="destructive"
              disabled
            >
              <DeviceGlyph icon={member.deviceIcon} className="size-3.5" />
              {member.deviceLabel}
            </DropdownMenuItem>
          ) : (
            <MaybeHostScope
              key={member.deviceId}
              deviceId={member.deviceId}
              api={member.api}
            >
              <ProjectRemoveMenuItem
                project={member.project}
                subject="project"
                removeArm={removeArm}
                device={{
                  id: member.deviceId,
                  label: member.deviceLabel,
                  icon: member.deviceIcon,
                }}
              />
            </MaybeHostScope>
          ),
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
