// The worktree header's mirror line: what this worktree's live mirror
// is doing, if it has one. One line per mirror the worktree is part
// of, on either side of it (hooks/remote/useMirrors.ts
// useWorktreeMirrorLinks): status, conflicts and problems, and the
// other device by name. A peer's mirror whose session is not in hand
// yet is named alone. Quiet when there is nothing to say. The details
// and the controls live in the dialog behind the footer's Mirror
// button (mirror/MirrorAction.tsx), which drives the session through
// the device running it.
// Built on the shared chip (ui/chip-button.tsx) and the status tones
// (ui/status-dot.tsx): emerald for a live mirror, sky while files or
// git state move (mirror/mirrorStatus.ts), amber for conflicts and
// reconnects, rose for a halt or an error, slate for paused.
import type { Worktree } from "@shared/schemas";
import { MirrorConflictsChip } from "@/components/worktreeDetail/MirrorConflicts";
import { describeMirror } from "@/components/worktreeDetail/mirror/mirrorStatus";
import {
  useWorktreeMirrorLinks,
  type WorktreeMirrorLink,
} from "@/hooks/remote/useMirrors";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";
import { type MirrorPillLine, MirrorPillView } from "./MirrorPillView";

export function MirrorPill({ worktree }: { worktree: Worktree }) {
  const links = useWorktreeMirrorLinks(worktree);
  const devices = useRemoteDevices();
  // The other device by name, as useDeviceName says it: "this device"
  // for this machine, a neutral phrase for one the registry forgot.
  const nameOf = (deviceId: string) =>
    deviceId === localDeviceId
      ? "this device"
      : (devices.find((device) => device.deviceId === deviceId)?.label ??
        "another device");
  return (
    <MirrorPillView
      lines={links.map((link) => lineOf(link, nameOf(link.otherDeviceId)))}
    />
  );
}

function lineOf(link: WorktreeMirrorLink, other: string): MirrorPillLine {
  const { session } = link;
  if (session === undefined) {
    return {
      key: link.runnerDeviceId,
      status: {
        tone: "emerald",
        label: "Mirrored",
        title: "A peer keeps a live copy of this worktree",
      },
      peer: `to ${other}`,
    };
  }
  const view = describeMirror(session);
  return {
    key: link.runnerDeviceId,
    status: {
      tone: view.tone,
      label: view.label,
      title: view.detail || view.label,
      spinning: view.spinning,
    },
    conflicts: view.showConflicts ? (
      <MirrorConflictsChip
        session={session}
        tone={view.tone}
        label={view.label}
        // Revealing is this machine's Finder, under the runner's
        // copy.
        canReveal={link.runnerDeviceId === localDeviceId}
      />
    ) : undefined,
    peer: `with ${other}`,
  };
}
