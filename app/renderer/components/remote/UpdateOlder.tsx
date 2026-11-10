// The update of whichever of two devices runs the older build of the
// app (UpdateDeviceButtonView), beside a note that says so
// (outdatedCopy.ts), where this window can ask for it: this machine's
// own, or a peer's while this build can call its updater and it takes
// this device's commands. Nothing otherwise: the note says where to
// update.
import { useUpdateDevice } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useHasLocalHost } from "@/lib/localHost";
import { commandAccessOf, type Device } from "@/lib/remote/devices";
import { useApi } from "@/lib/runtime/pageApi";
import { UpdateDeviceButtonView } from "@shigomori/ui/views/remote/RemoteScopeView.tsx";

export function UpdateOlder({ device }: { device: Device }) {
  const page = useApi();
  const hasLocalHost = useHasLocalHost();
  const { status } = device;
  if (!("outdated" in status)) return null;
  if (status.outdated === "this") {
    return hasLocalHost ? (
      <UpdateDeviceButton deviceId={page.deviceId} />
    ) : null;
  }
  const reachesUpdater =
    status.phase === "connected" &&
    !status.modules.includes("updater") &&
    commandAccessOf(device).granted;
  return reachesUpdater ? (
    <UpdateDeviceButton deviceId={device.deviceId} remote />
  ) : null;
}

// A peer's restarts another machine, so it asks for the second click
// Update all does. This machine's own install is attended.
function UpdateDeviceButton({
  deviceId,
  remote = false,
}: {
  deviceId: string;
  remote?: boolean;
}) {
  const { update, updating } = useUpdateDevice(deviceId);
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  return (
    <UpdateDeviceButtonView
      armed={confirm.armed}
      updating={updating}
      onClick={() => (remote ? confirm.trigger(update) : update())}
    />
  );
}
