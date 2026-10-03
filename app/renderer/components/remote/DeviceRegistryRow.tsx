// One machine on the account, as a row of the registry: its mark and
// name (changeable on every row, a peer's included, since both live on
// the device hub: the mark opens the icon picker, Rename the name),
// one line saying what state it is in and what it runs, the projects
// it hosts, and -- on THIS device's row -- the two things it
// exposes to the others: whether they may control it and whether it
// stays reachable to them. A peer's row makes no decision about the
// peer: what a machine allows is decided on that machine, so a peer
// row only reports the answer (read-only from here, or not) and holds
// the forwards this machine has open against it.
//
// Everything about a device is inside its own row, so nothing about a
// machine ever floats in a section of its own where it has to re-name
// the machine it applies to. Removing a peer is the row's only loud
// act, and it is armed inline: the sentence names the machine and the
// row is right there to check it against, which a dialog covering the
// list cannot offer. DeviceRegistryRowView draws the row.
import { useState } from "react";
import type { TunnelState } from "@shared/ipc/modules/hub";
import type { DeviceInfo } from "@shared/hub/protocol";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { AcceptCommandsToggle } from "./AcceptCommandsToggle";
import { DeviceHosts } from "./DeviceHosts";
import { DeviceIconPicker } from "./DeviceIconPicker";
import { DeviceNameField } from "./DeviceNameField";
import { DeviceRegistryRowView, deviceRowFacts } from "./DeviceRegistryRowView";
import { KeepReachableToggle } from "./KeepReachableToggle";
import { PortForwardSection } from "./PortForwardSection";
import type { HostChip } from "./deviceHostChips";
import type { DeviceRowStatus } from "./deviceRegistryStatus";

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
  // The name the row shows: this device's locally stored one, a peer's
  // registry one. Resolved by the registry so its collision check and
  // the row agree on what a machine is called.
  name: string;
  // What the row's mark draws: this device's own answer, a peer's
  // registry one, resolved by the registry like the name.
  icon: DeviceIcon;
  // Another row wears the same name, so the id has to tell them apart.
  showId: boolean;
  // Derived once by the registry so the marks cannot disagree with
  // anything else reading the same device.
  status: DeviceRowStatus;
  // The app version this machine runs, "" when unknown: a peer only
  // confirms it once its direct session's welcome lands.
  appVersion: string;
  chips: readonly HostChip[];
  chipsLoading: boolean;
  onRevokeDevice: () => void;
  revokePending: boolean;
  // THIS device's tunnel endpoint state, set on
  // the this-device row only. "up" joins the status phrase. The phases
  // that mean "peers off this network cannot reach me" get one quiet
  // line under it (tunnelNote), because that fact is what decides
  // whether the other machine can load this one's forest.
  tunnel: TunnelState | undefined;
  // Whether THIS device may run commands on the peer: the peer's own
  // switch, as it answers us. Resolved once for every row by the
  // registry rather than per row. Ignored on the this-device row.
  access: CommandAccess;
}) {
  // The shared two-step confirm carries the armed flag, so an untouched
  // banner disarms itself.
  const revoke = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // Held here rather than inside the name field so the Rename trigger
  // can sit in the row's action column while the editor opens on the
  // name itself.
  const [renaming, setRenaming] = useState(false);
  const { controlLabel, hostsCached } = deviceRowFacts({
    deviceId: device.deviceId,
    platform: device.platform,
    isThisDevice,
    name,
    showId,
    status,
  });

  return (
    <DeviceRegistryRowView
      deviceId={device.deviceId}
      platform={device.platform}
      isThisDevice={isThisDevice}
      name={name}
      showId={showId}
      status={status}
      appVersion={appVersion}
      tunnel={tunnel}
      access={access}
      canForwardPorts={canForwardPorts}
      renaming={renaming}
      onRename={() => setRenaming(true)}
      // The banner outlives the arming while the removal is in flight,
      // so the row shows "Removing…" where the confirm button was
      // instead of snapping back to its controls.
      confirming={revoke.armed || revokePending}
      revokePending={revokePending}
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
          cached={hostsCached}
        />
      }
      switches={
        <>
          <AcceptCommandsToggle />
          <KeepReachableToggle />
        </>
      }
      // Whether the peer will ACCEPT a new forward is its switch
      // (`access.granted`).
      portForwards={
        <PortForwardSection
          deviceId={device.deviceId}
          canStart={access.granted}
        />
      }
    />
  );
}
