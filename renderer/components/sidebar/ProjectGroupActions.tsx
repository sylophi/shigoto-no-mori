// The `+` and `…` a project header wears, for a group that may span
// several devices: this machine's checkout with the peers' merged into
// it (ProjectRow), or the peers' alone (RemoteProjectRow). Every member
// is a (device, project) pair with the api its actions run over, and
// each action mounts under that member's scope so quick create, the
// form and every menu page land on the right device with no
// remote-awareness of their own.
//
// The `+` creates instantly, on the group's designated device
// (useQuickCreateDeviceId) when it is live, else the first live member,
// this machine first. The `…` carries the designation as a "Quick
// create on" pick whenever there is a choice, then the action list:
// this machine's inline (or the one live peer's, on a remote-only
// header), and every other live peer's behind a submenu named for it.
// A member with no session gets no actions, the same as a missing
// local project.
import { Check, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import {
  useQuickCreateDeviceId,
  useSetQuickCreateDevice,
} from "@/hooks/config/useQuickCreateDevice";
import { MaybeHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";
import { ProjectMenuItems, useProjectMenuRemoveArm } from "./ProjectMenuItems";
import { QuickCreateButton } from "./QuickCreateButton";
import { PROJECT_MENU_TRIGGER_CLASS } from "./sidebarChrome";
import type { RemoteProjectMember } from "./sidebarRow";

export interface GroupMember {
  deviceId: string;
  deviceLabel: string;
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
  local: Project | undefined,
): GroupMember[] {
  const localName = useLocalDeviceName();
  const registry = useRemoteDevices();
  const access = usePeerCommandAccess(registry);
  const apis = peers.map((member) =>
    commandAccessOf(access, member.deviceId).canCommand
      ? registry.find((device) => device.deviceId === member.deviceId)?.api
      : undefined,
  );
  return [
    ...(local === undefined
      ? []
      : [
          {
            deviceId: localDeviceId,
            deviceLabel: localName,
            project: local,
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
  // The action list that shows inline: this machine's, or the only
  // live peer's on a header with no local checkout.
  const inline =
    members.find((member) => member.isThisDevice) ??
    (live.length === 1 ? live[0] : undefined);
  const submenus = live.filter((member) => member !== inline);
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  if (inline === undefined && live.length === 0) return null;

  return (
    <>
      {creator !== undefined && (
        <MaybeHostScope deviceId={creator.deviceId} api={creator.api}>
          <QuickCreateButton
            project={creator.project}
            isHovered={isHovered}
            deviceLabel={members.length > 1 ? creator.deviceLabel : undefined}
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
          {members.length > 1 && (
            <>
              <QuickCreatePick
                identity={identity}
                members={members}
                // The pick itself, as the Configure page ticks it. The
                // `+` falls back while the pick can't take a create.
                current={designatedId ?? creator?.deviceId}
              />
              <DropdownMenuSeparator />
            </>
          )}
          {inline !== undefined && (
            <MaybeHostScope deviceId={inline.deviceId} api={inline.api}>
              <ProjectMenuItems
                project={inline.project}
                subject="project"
                removeArm={removeArm}
              />
            </MaybeHostScope>
          )}
          {inline !== undefined && submenus.length > 0 && (
            <DropdownMenuSeparator />
          )}
          {submenus.map((member) => (
            <MemberSubmenu key={member.deviceId} member={member} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// The designation pick. Lives inside the menu content, so its writer
// exists only while the menu is open rather than on every header.
function QuickCreatePick({
  identity,
  members,
  current,
}: {
  identity: string | null | undefined;
  members: readonly GroupMember[];
  current: string | undefined;
}) {
  const setDevice = useSetQuickCreateDevice(identity);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Quick create on</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Where the + creates</DropdownMenuLabel>
          {members.map((member) => (
            <DropdownMenuItem
              key={member.deviceId}
              onClick={() => setDevice(member.deviceId)}
            >
              <Check
                className={cn(
                  "size-3.5",
                  current === member.deviceId ? "opacity-100" : "opacity-0",
                )}
              />
              {member.deviceLabel}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// One peer's action list behind its own submenu, each with its own
// remove arm so a confirm on one device never carries to another.
function MemberSubmenu({ member }: { member: LiveMember }) {
  const { removeArm, onOpenChange } = useProjectMenuRemoveArm();
  return (
    <DropdownMenuSub onOpenChange={onOpenChange}>
      <DropdownMenuSubTrigger>{member.deviceLabel}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <MaybeHostScope deviceId={member.deviceId} api={member.api}>
          <ProjectMenuItems
            project={member.project}
            subject="project"
            removeArm={removeArm}
          />
        </MaybeHostScope>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
