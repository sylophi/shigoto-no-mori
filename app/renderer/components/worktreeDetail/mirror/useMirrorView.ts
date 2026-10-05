// A mirror link as its surfaces word it (the header pill, the footer
// button, the dialog): both devices by name, the line describeMirror
// ranks off the session and what is known beside it (the runner out of
// reach, its engine restarting), and the root this machine can reveal
// the session's paths under, when it holds either side.
import type { MirrorSession } from "@shared/ipc/modules/mirror";
import type { WorktreeMirrorLink } from "@/hooks/remote/useMirrors";
import { useDeviceProperName } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";
import { describeMirror } from "./mirrorStatus";

export function useMirrorView(
  link: WorktreeMirrorLink,
  session: MirrorSession,
) {
  const runner = useDeviceProperName(link.runnerDeviceId);
  const copy = useDeviceProperName(session.deviceId);
  const other = useDeviceProperName(link.otherDeviceId);
  const view = describeMirror(session, {
    runnerAway: link.runnerApi === undefined ? runner : undefined,
    engine: link.engine,
  });
  const revealUnder =
    link.runnerDeviceId === localDeviceId
      ? session.localRoot
      : session.deviceId === localDeviceId
        ? session.remoteRoot
        : undefined;
  return {
    view,
    names: { runner, copy, other },
    revealUnder,
  };
}
