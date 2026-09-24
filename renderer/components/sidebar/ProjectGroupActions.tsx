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
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { useLocalDevice } from "@/hooks/account/useAccount";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { useQuickCreateDeviceId } from "@/hooks/sharedSettings/useQuickCreateDevice";
import { MaybeHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
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

type LiveMember = GroupMember & { api: HostApi };

// The group as the actions see it: this machine's checkout first when
// there is one, then every peer's with the api its session provides,
// where that peer lets this device command it (the same preflight the
// new-worktree picker reads, and while it is still in flight the peer
// is assumed granted rather than flashing actions in and out).
export function useGroupMembers(
  peers: readonly RemoteProjectMember[],
  localProject: Project | undefined,
): GroupMember[] {
  const local = useLocalDevice();
  const registry = useRemoteDevices();
  const access = usePeerCommandAccess(registry);
  const apis = peers.map((member) =>
    commandAccessOf(access, member.deviceId).canCommand
      ? registry.find((device) => device.deviceId === member.deviceId)?.api
      : undefined,
  );
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

interface ProjectGroupActionsProps {
  name: string;
  // The group's repo identity, which the designation is keyed by.
  identity: string | null | undefined;
  members: readonly GroupMember[];
  isHovered: boolean;
  // The `…` trigger, so the header's right-click can pop the same menu.
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export function ProjectGroupActions({
  name,
  identity,
  members,
  isHovered,
  triggerRef,
}: ProjectGroupActionsProps) {
  const designatedId = useQuickCreateDeviceId(identity);
  const live = members.filter(
    (member): member is LiveMember => member.api !== undefined,
  );
  // Where the `+` creates: the pick when it can, else the first live
  // member (this machine leads the list when it is one). A missing
  // local checkout can't take a create either.
  const canCreate = live.filter(
    (member) => member.project.pathExists !== false,
  );
  const creator =
    canCreate.find((member) => member.deviceId === designatedId) ??
    canCreate[0];
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
// header's badges, which already say it is away. Leaving the submenu
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
