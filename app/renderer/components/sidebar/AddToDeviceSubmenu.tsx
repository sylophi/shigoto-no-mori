// "Add to device": the project menu's way onto a machine that doesn't
// hold the repo yet. It lists the devices that register projects and
// aren't among the group's members, and a pick opens the add-project
// dialog on that device with the repo's remote already in the input,
// so getting a project onto a new machine is the pick, a glance at the
// folder, and ↩. The clone itself is the dialog's (AddProjectView).
//
// The remote comes from a member that has the repo. projects:cloneUrl
// is a read, so any member with a session can answer it, including a
// peer that won't take commands from here: bringing its repo to THIS
// machine needs nothing of it but the URL.
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useDeviceTabs, type DeviceTab } from "@/components/shared/DeviceTabs";
import { useOverlays } from "@/hooks/ui/useOverlays";
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
  const { openAddProject } = useOverlays();

  const holders = new Set(members.map((member) => member.deviceId));
  const candidates = tabs.filter((tab) => !holders.has(tab.deviceId));
  // The tab's api rather than the member's: a member's is withheld
  // without the command grant, which a read doesn't need, and a tab's
  // is simply the device's session (window.api for this one). A peer
  // in the roster has an api before it has a session to carry a call,
  // so a member that can answer now goes ahead of one that may not.
  const sources = members.flatMap((member) => {
    const tab = tabs.find((t) => t.deviceId === member.deviceId);
    return tab?.api === undefined
      ? []
      : [
          {
            project: member.project,
            api: tab.api,
            live: tab.block !== "offline",
          },
        ];
  });
  const source = sources.find((member) => member.live) ?? sources[0];
  if (candidates.length === 0 || source === undefined) return null;
  const { api, project } = source;

  const addTo = async (tab: DeviceTab) => {
    const url = await api.projects.cloneUrl(project.id).catch((err) => {
      notifyError(`Couldn't read ${name}'s remote`, err);
      return undefined;
    });
    if (url === undefined) return;
    if (url === null) {
      // Nothing to clone from. The dialog still opens there, to browse:
      // the repo may already sit on that disk, just never registered.
      toast(`${name} has no remote to clone from`, {
        description: `If ${tab.label} already has a copy, add it by its folder.`,
      });
    }
    openAddProject({ deviceId: tab.deviceId, query: url ?? undefined });
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
            <DeviceGlyph icon={tab.icon} className="size-3.5" />
            {tab.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
