// One machine on the account, as a row of the registry: its mark and
// name, one line saying what state it is in and what it runs, the
// projects it hosts, and -- on THIS device's row -- the two things it
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
// list cannot offer.
import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { TunnelState } from "@shared/ipc/modules/hub";
import type { DeviceInfo } from "@shared/hub/protocol";
import { Button } from "@/components/ui/button";
import { RowTag } from "@/components/ui/row-tag";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { abbreviateId } from "@/lib/abbreviateId";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { cn } from "@/lib/utils";
import { AcceptCommandsToggle } from "./AcceptCommandsToggle";
import { DeviceAvatar } from "./DeviceAvatar";
import { DeviceHosts } from "./DeviceHosts";
import { DeviceNameField, DeviceRenameButton } from "./DeviceNameField";
import { KeepReachableToggle } from "./KeepReachableToggle";
import { PortForwardSection } from "./PortForwardSection";
import type { HostChip } from "./deviceHostChips";
import { tunnelNote, type DeviceRowStatus } from "./deviceRegistryStatus";
import { deviceTraits } from "./deviceTraits";

export function DeviceRegistryRow({
  device,
  isThisDevice,
  name,
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
  // THIS device's tunnel endpoint state (v2 step 10, slice B), set on
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
  // The banner outlives the arming while the removal is in flight, so
  // the row shows "Removing…" where the confirm button was instead of
  // snapping back to its controls.
  const confirming = revoke.armed || revokePending;
  // Held here rather than inside the name field so the Rename trigger
  // can sit in the row's action column while the editor opens on the
  // name itself.
  const [renaming, setRenaming] = useState(false);
  const traits = deviceTraits(device.platform);
  // A peer that is up and has ANSWERED "no" is read-only from here.
  // Nothing is said while the verdict is in flight, when the preflight
  // itself failed (that is transport, not the peer's switch), when the
  // peer is unreachable (it cannot run anything anyway), or for a
  // browser, which has no switch to point at.
  const readOnlyHere =
    !isThisDevice &&
    traits.exposable &&
    status.reachable &&
    !access.isLoading &&
    !access.isError &&
    !access.granted;
  const note = isThisDevice
    ? tunnelNote(tunnel)
    : readOnlyHere
      ? peerReadOnlyNote(name)
      : null;
  // The tunnel being up is part of what "online" means for this
  // machine, so it joins the state phrase rather than trailing it.
  const stateLabel =
    isThisDevice && tunnel === "up"
      ? `${status.label}, reachable from anywhere`
      : status.label;

  return (
    // The mark hangs beside the header only. Everything under it (the
    // note, the project strip, the switches or forwards, the armed
    // banner) runs the row's full width, so nothing is indented for
    // the sake of a column it does not belong to.
    <li className="flex flex-col gap-3 py-5 first:pt-1 last:pb-1">
      <div className="flex gap-3.5">
        <DeviceAvatar name={name} tone={status.tone} />

        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {isThisDevice ? (
                <DeviceNameField
                  deviceName={name}
                  label={traits.selfLabel}
                  editing={renaming}
                  onEditingChange={setRenaming}
                  className="text-base"
                />
              ) : (
                <span className="truncate text-base font-medium">{name}</span>
              )}
              {isThisDevice && !renaming && <RowTag>{traits.selfLabel}</RowTag>}
              {showId && (
                <span
                  title={device.deviceId}
                  className="font-mono text-[11px] text-muted-foreground/70 select-text"
                >
                  {abbreviateId(device.deviceId)}
                </span>
              )}
            </div>

            {/* Two facts, each in its own place: the state, which the
                dot colours, and what the machine runs. */}
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <StatusDot
                tone={status.tone}
                label={
                  <span
                    className={cn(
                      "text-xs font-medium",
                      TONE_TEXT[status.tone],
                    )}
                  >
                    {stateLabel}
                  </span>
                }
              />
              <span>{traits.spec(appVersion)}</span>
            </p>
          </div>

          {!confirming && (
            <div className="flex shrink-0 items-center">
              {isThisDevice ? (
                !renaming && (
                  <DeviceRenameButton
                    label={traits.selfLabel}
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
                  aria-label={`Remove ${name} from account`}
                  onClick={() => revoke.trigger(onRevokeDevice)}
                >
                  <Trash2 />
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}

      {traits.hostsProjects && (
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
      )}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          <p className="min-w-0 flex-1 basis-64">
            <span className="font-medium">
              Remove {name} from your account?
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
      ) : isThisDevice ? (
        // What this machine exposes to the account's other devices,
        // in the order a person asks: may they drive it, and will it
        // be there when they try. A browser exposes neither.
        traits.exposable && (
          <div className="flex flex-col gap-3">
            <AcceptCommandsToggle />
            <KeepReachableToggle />
          </div>
        )
      ) : (
        // Forwarding binds a real listener on THIS machine, so it is
        // app-only, and against a machine that serves calls, so never a
        // browser. Whether the peer will ACCEPT a new forward is its
        // switch (`access.granted`). The strip renders itself away
        // when it can neither start one nor show a live one.
        canForwardPorts &&
        traits.exposable && (
          <PortForwardSection
            deviceId={device.deviceId}
            canStart={access.granted}
          />
        )
      )}
    </li>
  );
}
