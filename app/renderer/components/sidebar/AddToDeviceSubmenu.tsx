// "Add to device": the project menu's way onto a machine that doesn't
// hold the repo yet. It lists the devices that register projects and
// aren't among the group's members, and a pick opens a dialog naming
// where the clone lands there: the member's own layout with the two
// homes swapped, or a folder picked on that device. The project is
// cloned there from a member's checkout, settings and carry-over files
// included (projects:cloneFromDevice, what `sm projects clone` runs
// too).
//
// The clone runs on the picked device, which asks the member for the
// repo itself: the member needs to take commands from that device, not
// from this one.
import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { ProgressBar } from "@shigomori/ui/primitives/progress-bar.tsx";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { cloneFromDeviceProgressBar } from "@shigomori/ui/views/addProject/cloneProgress.ts";
import { AddToDeviceDialogView } from "@shigomori/ui/views/sidebar/AddToDeviceDialogView.tsx";
import { DeviceMenuRowView } from "@shigomori/ui/views/sidebar/DeviceMenuRowView.tsx";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { useDeviceTabs } from "@/components/shared/DeviceTabs";
import {
  CloneFolderPicker,
  useCloneDestination,
} from "@/components/worktreeDetail/flow/cloneDestination";
import { notifyError, toast } from "@/lib/toast";
import { pluralize } from "@shigomori/contracts/words";
import { useCloneFromDeviceProgress } from "@/hooks/projects/useCloneProgress";
import {
  DestinationProvider,
  DeviceScope,
  type HostApi,
  useDestinationScope,
} from "@/hooks/remote/useHostScope";
import type { GroupMember } from "./ProjectGroupActions";

// The pick: the member the project is cloned from, and the device it
// goes to. Held here and drawn once beside the app's other overlays
// (AddToDeviceDialog), so the dialog outlives the menu and the row
// that opened it.
interface AddPick {
  source: GroupMember;
  deviceId: string;
  deviceLabel: string;
}
const pickAtom = Atom.keepAlive(Atom.make<AddPick | null>(null));

export function AddToDeviceSubmenu({
  members,
  onOpenChange,
}: {
  members: readonly GroupMember[];
  onOpenChange: (open: boolean) => void;
}) {
  const tabs = useDeviceTabs();
  const setPick = useAtomSet(pickAtom);
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
            onClick={() =>
              setPick({
                source,
                deviceId: tab.deviceId,
                deviceLabel: tab.label,
              })
            }
          >
            <DeviceMenuRowView icon={tab.icon} label={tab.label} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// The dialog for the pick. Its reads are the flows' clone destination's,
// the member as the source and the picked device as the destination.
export function AddToDeviceDialog() {
  const pick = useAtomValue(pickAtom);
  const setPick = useAtomSet(pickAtom);
  if (pick === null) return null;
  const onClose = () => setPick(null);
  const title = `Add ${pick.source.project.name} to ${pick.deviceLabel}`;
  return (
    <ModalShell label={title} onClose={onClose} popoverClassName="max-w-md">
      <DeviceScope deviceId={pick.source.deviceId}>
        <DestinationProvider peer={pick}>
          <AddToDeviceForm
            title={title}
            deviceLabel={pick.deviceLabel}
            source={pick.source}
            onClose={onClose}
          />
        </DestinationProvider>
      </DeviceScope>
    </ModalShell>
  );
}

function AddToDeviceForm({
  title: dialogTitle,
  deviceLabel,
  source,
  onClose,
}: {
  title: string;
  deviceLabel: string;
  source: GroupMember;
  onClose: () => void;
}) {
  const { api } = useDestinationScope();
  const clone = useCloneDestination(source.project, true, undefined);
  const [picking, setPicking] = useState(false);
  const name = source.project.name;

  const add = () => {
    onClose();
    const title = `Cloning ${name} onto ${deviceLabel}…`;
    const id = toast.loading(title, {
      description: (
        <CloneProgressBar
          api={api}
          deviceId={source.deviceId}
          projectId={source.project.id}
          label={title}
        />
      ),
    });
    api
      .run(
        api.projects.cloneFromDevice({
          deviceId: source.deviceId,
          projectId: source.project.id,
          parentDir: clone.cloneInto.parentDir,
        }),
      )
      .then(
        ({ project, settings, files }) => {
          const conflicts = files?.conflicts ?? 0;
          const missed = [
            ...(settings.copied ? [] : [`its settings: ${settings.error}`]),
            ...(files?.error === undefined
              ? []
              : [`its carry-over files: ${files.error}`]),
            ...(conflicts > 0
              ? [
                  `${pluralize(conflicts, "carry-over path")}, since the checkout there has its own`,
                ]
              : []),
          ];
          if (missed.length === 0) {
            toast.success(`Added ${name} on ${deviceLabel}`, {
              id,
              description: project.path,
            });
          } else {
            toast.warning(
              `Added ${name} on ${deviceLabel}, without all of it`,
              {
                id,
                description: missed.join(". "),
              },
            );
          }
        },
        (err: unknown) => {
          toast.dismiss(id);
          notifyError(`Couldn't add ${name} on ${deviceLabel}`, err);
        },
      );
  };

  return (
    <AddToDeviceDialogView
      title={dialogTitle}
      clone={clone}
      onChangeParent={() => setPicking(true)}
      picker={
        picking && (
          <CloneFolderPicker clone={clone} onClose={() => setPicking(false)} />
        )
      }
      onAdd={add}
      onCancel={onClose}
    />
  );
}

// The toast's bar, following the clone itself, so a frame redraws the
// bar and not the toast.
function CloneProgressBar({
  api,
  deviceId,
  projectId,
  label,
}: {
  api: HostApi;
  deviceId: string;
  projectId: string;
  label: string;
}) {
  const progress = useCloneFromDeviceProgress(api, deviceId, projectId);
  return (
    progress && (
      <ProgressBar
        {...cloneFromDeviceProgressBar(progress)}
        label={label}
        className="mt-1.5 items-start"
      />
    )
  );
}
