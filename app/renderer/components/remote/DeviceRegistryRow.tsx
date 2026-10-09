import { useState } from "react";
import type { TunnelState } from "@shigomori/contracts/modules/hub";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useSharing } from "@/hooks/account/useSharing";
import { AcceptCommandsToggle } from "./AcceptCommandsToggle";
import { DeviceHosts } from "./DeviceHosts";
import { DeviceIconPicker } from "./DeviceIconPicker";
import { DeviceNameField } from "./DeviceNameField";
import {
  deviceRowLabels,
  DeviceRegistryRowView,
  ExposureSwitchesView,
} from "./DeviceRegistryRowView";
import { KeepReachableToggle } from "./KeepReachableToggle";
import { PortForwardSection } from "./PortForwardSection";
import { ShareDataToggle } from "./ShareDataToggle";
import type { HostChip } from "./deviceHostChips";
import type { DeviceRowStatus } from "./deviceRegistryStatus";

// A registry row (DeviceRegistryRowView) with its rename and removal
// state and the controls that write to the hub and this machine.
export function DeviceRegistryRow({
  device,
  isThisDevice,
  name,
  icon,
  showId,
  status,
  appVersion,
  chips,
  chipsLoading,
  onRevokeDevice,
  revokePending,
  tunnel,
  access,
}: {
  device: DeviceInfo;
  isThisDevice: boolean;
  name: string;
  // What the row's mark draws: this device's own answer, a peer's
  // registry one, resolved by the registry like the name.
  icon: DeviceIcon;
  showId: boolean;
  status: DeviceRowStatus;
  appVersion: string;
  chips: readonly HostChip[];
  chipsLoading: boolean;
  onRevokeDevice: () => void;
  revokePending: boolean;
  tunnel: TunnelState | undefined;
  access: CommandAccess;
}) {
  // The shared two-step confirm carries the armed flag, so an untouched
  // banner disarms itself.
  const revoke = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // Held here rather than inside the name field so the Rename trigger
  // can sit in the row's action column while the editor opens on the
  // name itself.
  const [renaming, setRenaming] = useState(false);
  const { traits, controlLabel } = deviceRowLabels({
    device,
    isThisDevice,
    name,
    showId,
  });
  return (
    <DeviceRegistryRowView
      device={device}
      isThisDevice={isThisDevice}
      name={name}
      showId={showId}
      status={status}
      appVersion={appVersion}
      tunnel={tunnel}
      access={access}
      renaming={renaming}
      // The banner outlives the arming while the removal is in flight,
      // so the row shows "Removing…" where the confirm button was
      // instead of snapping back to its controls.
      confirming={revoke.armed || revokePending}
      revokePending={revokePending}
      onRename={() => setRenaming(true)}
      onRemove={() => revoke.trigger(onRevokeDevice)}
      onCancelRemove={revoke.reset}
      iconPicker={
        <DeviceIconPicker
          deviceId={device.deviceId}
          isThisDevice={isThisDevice}
          icon={icon}
          tone={status.tone}
          label={controlLabel}
        />
      }
      nameField={
        <DeviceNameField
          deviceId={device.deviceId}
          deviceName={name}
          label={controlLabel}
          editing={renaming}
          onEditingChange={setRenaming}
          className="text-base"
        />
      }
      hosts={
        <DeviceHosts
          deviceId={device.deviceId}
          chips={chips}
          loading={chipsLoading}
          // A peer that is not reachable cannot be listing anything
          // right now, so whatever chips it has are its last session's,
          // and the strip says so instead of implying the counts are
          // current. This device's chips are local and always live,
          // whatever its hub socket is doing.
          cached={!isThisDevice && !status.reachable}
        />
      }
      exposure={
        isThisDevice
          ? // A browser exposes nothing to the account's other devices.
            traits.exposable && <ExposureSwitches />
          : // Forwarding binds a real listener on THIS machine, so it is
            // app-only, and against a machine that serves calls, so never
            // a browser. Whether the peer will ACCEPT a new forward is its
            // switch (`access.granted`). The strip renders itself away
            // when it can neither start one nor show a live one.
            canForwardPorts &&
            traits.exposable && (
              <PortForwardSection
                deviceId={device.deviceId}
                canStart={access.granted}
              />
            )
      }
    />
  );
}

// Not sharing, there is nothing to control.
function ExposureSwitches() {
  const sharing = useSharing().data !== false;
  return (
    <ExposureSwitchesView>
      <ShareDataToggle />
      {sharing && <AcceptCommandsToggle />}
      <KeepReachableToggle />
    </ExposureSwitchesView>
  );
}
