// "Add to device": the project menu's way onto a machine that doesn't
// hold the repo yet. It lists the devices that register projects and
// aren't among the group's members, and a pick clones the project
// there from a member's checkout, settings and carry-over files
// included, into the member's own layout (projects:cloneFromDevice,
// what `sm projects clone` runs too).
//
// The clone runs on the picked device, which asks the member for the
// repo itself: the member needs to take commands from that device, not
// from this one.
import { DeviceMenuRowView } from "@shigomori/ui/views/sidebar/DeviceMenuRowView.tsx";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { useDeviceTabs, type DeviceTab } from "@/components/shared/DeviceTabs";
import { notifyError, toast } from "@/lib/toast";
import type { GroupMember } from "./ProjectGroupActions";

export function AddToDeviceSubmenu({
  name,
  members,
  onOpenChange,
}: {
  name: string;
  members: readonly GroupMember[];
  onOpenChange: (open: boolean) => void;
}) {
  const tabs = useDeviceTabs();

  const holders = new Set(members.map((member) => member.deviceId));
  const candidates = tabs.filter((tab) => !holders.has(tab.deviceId));
  // A member this device reaches and commands goes ahead of one that may
  // not serve the clone.
  const source =
    members.find((member) => {
      const tab = tabs.find((each) => each.deviceId === member.deviceId);
      return tab !== undefined && tab.block === undefined;
    }) ?? members[0];
  if (candidates.length === 0 || source === undefined) return null;

  const addTo = (tab: DeviceTab) => {
    const { api } = tab;
    if (api === undefined) return;
    const id = toast.loading(`Cloning ${name} onto ${tab.label}…`);
    api
      .run(
        api.projects.cloneFromDevice({
          deviceId: source.deviceId,
          projectId: source.project.id,
        }),
      )
      .then(
        ({ project, settings, files }) => {
          const missed = [
            ...(settings.copied ? [] : [`its settings: ${settings.error}`]),
            ...(files?.error === undefined
              ? []
              : [`its carry-over files: ${files.error}`]),
            ...((files?.conflicts ?? 0) > 0
              ? [
                  `${files?.conflicts} carry-over ${files?.conflicts === 1 ? "path" : "paths"}, since the checkout there has its own`,
                ]
              : []),
          ];
          if (missed.length === 0) {
            toast.success(`Added ${name} on ${tab.label}`, {
              id,
              description: project.path,
            });
          } else {
            toast.warning(`Added ${name} on ${tab.label}, without all of it`, {
              id,
              description: missed.join(". "),
            });
          }
        },
        (err: unknown) => {
          toast.dismiss(id);
          notifyError(`Couldn't add ${name} on ${tab.label}`, err);
        },
      );
  };

  return (
    <DropdownMenuSub onOpenChange={onOpenChange}>
      <DropdownMenuSubTrigger>Add to device</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {candidates.map((tab) => (
          // A device that is away, or takes no commands from here, stays
          // listed but inert, the way the Remove submenu keeps its own.
          <DropdownMenuItem
            key={tab.deviceId}
            disabled={tab.block !== undefined}
            onClick={() => void addTo(tab)}
          >
            <DeviceMenuRowView icon={tab.icon} label={tab.label} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
