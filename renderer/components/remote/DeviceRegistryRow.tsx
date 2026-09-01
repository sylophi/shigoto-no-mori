// One machine on the account, as a row of the registry: its mark and
// name, one line saying what state it is in and what it runs, the
// projects it hosts, and the one decision this host makes about it --
// whether it may run commands here (a peer) or whether this machine
// stays reachable to the others (this device) -- as a single switch in
// the same place on every row. Under a peer, the forwards this machine
// holds against it, since the PEER's grant allows those.
//
// Everything about a device is inside its own row, so nothing about a
// machine ever floats in a section of its own where it has to re-name
// the machine it applies to. Removing a peer is the row's only loud
// act, and it is armed inline: the sentence names the machine and the
// row is right there to check it against, which a dialog covering the
// list cannot offer.
import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { TunnelState } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import { ToggleRow } from "@/components/settings/ToggleRow";
import { Button } from "@/components/ui/button";
import { RowTag } from "@/components/ui/row-tag";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { cn } from "@/lib/utils";
import { DeviceAvatar } from "./DeviceAvatar";
import { DeviceHosts } from "./DeviceHosts";
import { DeviceNameField, DeviceRenameButton } from "./DeviceNameField";
import { KeepReachableToggle } from "./KeepReachableToggle";
import { PortForwardSection } from "./PortForwardSection";
import type { HostChip } from "./deviceHostChips";
import { platformLabel } from "@/lib/platformLabel";
import { tunnelNote, type DeviceRowStatus } from "./deviceRegistryStatus";

export function DeviceRegistryRow({
  device,
  isThisDevice,
  localDeviceName,
  status,
  appVersion,
  chips,
  chipsLoading,
  granted,
  grantPending,
  onGrant,
  onRevokeCommands,
  onRevokeDevice,
  revokePending,
  tunnel,
  canCommandPeer,
}: {
  device: DeviceInfo;
  isThisDevice: boolean;
  // This device's stored name, which setDeviceName writes locally while
  // the relay registry keeps the name it enrolled under. The local one
  // is the truth the user just typed, so the row shows it.
  localDeviceName: string;
  // Derived once by the registry, which needs the same reading for its
  // summary line, so the count and the marks cannot disagree.
  status: DeviceRowStatus;
  // The app version this machine runs, "" when unknown: a peer only
  // confirms it once its direct session's welcome lands.
  appVersion: string;
  chips: readonly HostChip[];
  chipsLoading: boolean;
  granted: boolean;
  grantPending: boolean;
  onGrant: () => void;
  onRevokeCommands: () => void;
  onRevokeDevice: () => void;
  revokePending: boolean;
  // THIS device's tunnel endpoint state (v2 step 10, slice B), set on
  // the this-device row only. "up" earns a token on the status line.
  // The phases that mean "peers off this network cannot reach me" get
  // one quiet line under it (tunnelNote), because that fact is what
  // decides whether the other machine can load this one's forest.
  tunnel: TunnelState | undefined;
  // The OTHER direction from `granted`: true when THIS device holds
  // command access on the peer, so it may drive verbs there. Resolved
  // once for every row by the registry rather than per row.
  canCommandPeer: boolean;
}) {
  // The shared two-step confirm carries the armed flag, so an untouched
  // banner disarms itself.
  const revoke = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // The banner outlives the arming while the removal is in flight, so
  // the row shows "Removing…" where the confirm button was instead of
  // snapping back to its controls.
  const confirming = revoke.armed || revokePending;
  // Held here rather than inside the name field so the Rename trigger
  // can sit in the row's action column while the editor opens on the
  // name itself.
  const [renaming, setRenaming] = useState(false);
  const note = tunnelNote(tunnel);
  const name = isThisDevice ? localDeviceName : device.name;

  return (
    <li className="flex gap-3.5 py-5 first:pt-1 last:pb-1">
      <DeviceAvatar name={name} tone={status.tone} />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {isThisDevice ? (
                <DeviceNameField
                  deviceName={localDeviceName}
                  label="This device"
                  editing={renaming}
                  onEditingChange={setRenaming}
                  className="text-base"
                />
              ) : (
                <span className="truncate text-base font-medium">
                  {device.name}
                </span>
              )}
              {isThisDevice && !renaming && <RowTag>This device</RowTag>}
            </div>

            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <StatusDot
                tone={status.tone}
                label={
                  <span
                    className={cn(
                      "text-xs font-medium",
                      TONE_TEXT[status.tone],
                    )}
                  >
                    {status.label}
                  </span>
                }
              />
              <span aria-hidden>·</span>
              <span>{platformLabel(device.platform)}</span>
              {appVersion !== "" && (
                <>
                  <span aria-hidden>·</span>
                  <span>v{appVersion}</span>
                </>
              )}
              {tunnel === "up" && (
                <>
                  <span aria-hidden>·</span>
                  <span>Reachable from anywhere</span>
                </>
              )}
              {/* The one fact that tells two machines with the same
                  name apart, which the Remove confirm relies on. */}
              <span aria-hidden>·</span>
              <span className="font-mono text-[11px] text-muted-foreground/70 select-text">
                {device.deviceId}
              </span>
            </p>
          </div>

          {!confirming && (
            <div className="flex shrink-0 items-center">
              {isThisDevice ? (
                !renaming && (
                  <DeviceRenameButton
                    label="This device"
                    onClick={() => setRenaming(true)}
                  />
                )
              ) : (
                <Button
                  // Muted until hovered: a rose "Remove" on every peer
                  // row would make the page's rarest act its loudest.
                  // The armed banner below spells out what it does.
                  // (Self-removal is not offered: it would invalidate
                  // this app's own credential, and with the Clerk
                  // session still live ClerkAccountSync would re-enroll
                  // the machine straight back. Sign out, on the
                  // account line above, is the honest version.)
                  variant="ghost-destructive"
                  size="xs"
                  className="text-muted-foreground"
                  aria-label={`Remove ${device.name} from account`}
                  onClick={() => revoke.trigger(onRevokeDevice)}
                >
                  <Trash2 />
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>

        {note !== null && (
          <p className="text-xs text-muted-foreground">{note}</p>
        )}

        <DeviceHosts
          deviceId={device.deviceId}
          chips={chips}
          loading={chipsLoading}
          // A machine that is not reachable cannot be listing anything
          // right now, so whatever chips it has are its last session's,
          // and the strip says so instead of implying the counts are
          // current.
          cached={!status.reachable}
        />

        {confirming ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-700 dark:text-rose-300">
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            <p className="min-w-0 flex-1 basis-64">
              <span className="font-medium">
                Remove {device.name} from your account?
              </span>{" "}
              It loses access the moment it next connects, and its projects
              disappear from your sidebar. Worktrees and files on the machine
              itself are left alone. Pair again to undo.
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="xs"
                disabled={revokePending}
                onClick={revoke.reset}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="xs"
                disabled={revokePending}
                onClick={() => revoke.trigger(onRevokeDevice)}
              >
                {revokePending ? "Removing…" : "Remove device"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {isThisDevice ? (
              <KeepReachableToggle />
            ) : (
              <ToggleRow
                // Host-local, so it works on an offline row too -- which
                // is the point: you decide what a machine may do here
                // before it next knocks.
                checked={granted}
                onCheckedChange={(next) =>
                  next ? onGrant() : onRevokeCommands()
                }
                disabled={grantPending}
                label="Can run commands here"
                description={`Lets ${device.name} create and remove worktrees, run scripts and change settings on this machine. Off keeps it read-only.`}
              />
            )}

            {/* Forwarding binds a real listener on THIS machine, so it
                is app-only. Whether the peer will ACCEPT a new forward
                is `canCommandPeer`; the strip renders itself away when
                it can neither start one nor show a live one. */}
            {!isThisDevice && canForwardPorts && (
              <PortForwardSection
                deviceId={device.deviceId}
                canStart={canCommandPeer}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
}
