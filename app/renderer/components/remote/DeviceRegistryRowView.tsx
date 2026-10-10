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
// list cannot offer.
import type { ReactNode } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { TunnelState } from "@shigomori/contracts/modules/hub";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { RowTag } from "@shigomori/ui/primitives/row-tag.tsx";
import { StatusDot, TONE_TEXT } from "@shigomori/ui/primitives/status-dot.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { abbreviateId } from "@/lib/abbreviateId";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { deviceTraits } from "@/lib/remote/deviceTraits";
import { DeviceRenameButtonView } from "./DeviceNameFieldView";
import { tunnelNote, type DeviceRowStatus } from "./deviceRegistryStatus";

// What the row's controls call the machine: this one by its role, a
// peer by name, and where the name alone cannot pick it out, the same
// id fragment the header shows joins it, so the Remove button a screen
// reader announces and the confirm sentence name one machine rather
// than two identical ones.
export function deviceRowLabels({
  device,
  isThisDevice,
  name,
  showId,
}: {
  device: DeviceInfo;
  isThisDevice: boolean;
  name: string;
  showId: boolean;
}) {
  const traits = deviceTraits(device.platform);
  const namedDevice = showId
    ? `${name} ${abbreviateId(device.deviceId)}`
    : name;
  return {
    traits,
    namedDevice,
    controlLabel: isThisDevice ? traits.selfLabel : namedDevice,
  };
}

export function DeviceRegistryRowView({
  device,
  isThisDevice,
  name,
  showId,
  status,
  appVersion,
  tunnel,
  access,
  renaming,
  confirming,
  revokePending,
  onRename,
  onRemove,
  onCancelRemove,
  iconPicker,
  nameField,
  hosts,
  exposure,
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
  // THIS device's tunnel endpoint state, set on the this-device row
  // only. "up" joins the status phrase. The phases that mean "peers off
  // this network cannot reach me" get one quiet line under it
  // (tunnelNote), because that fact is what decides whether the other
  // machine can load this one's forest.
  tunnel: TunnelState | undefined;
  // Whether THIS device may run commands on the peer: the peer's own
  // switch, as it answers us. Ignored on the this-device row.
  access: CommandAccess;
  // The name is open for editing (in `nameField`).
  renaming: boolean;
  // The removal is armed, or in flight.
  confirming: boolean;
  revokePending: boolean;
  onRename: () => void;
  // Asked twice: the first arms the banner, the second removes.
  onRemove: () => void;
  onCancelRemove: () => void;
  // The mark that opens the icon picker, and the name or its editor.
  iconPicker: ReactNode;
  nameField: ReactNode;
  // The projects it hosts.
  hosts: ReactNode;
  // On this device's row, what it exposes to the others. On a peer's,
  // the forwards this machine holds against it.
  exposure: ReactNode;
}) {
  const { traits, namedDevice, controlLabel } = deviceRowLabels({
    device,
    isThisDevice,
    name,
    showId,
  });
  // A peer that is up and has SAID "no" is read-only from here.
  // Nothing is said before its session reports, when the peer is
  // unreachable (it cannot run anything anyway), or for a browser,
  // which has no switch to point at.
  const readOnlyHere =
    !isThisDevice &&
    traits.exposable &&
    status.reachable &&
    !access.isLoading &&
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
        {iconPicker}

        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {nameField}
              {isThisDevice && !renaming && <RowTag>{traits.selfLabel}</RowTag>}
              {showId && (
                <SimpleTooltip tip={device.deviceId}>
                  <span className="font-mono text-2xs text-muted-foreground/70 select-text">
                    {abbreviateId(device.deviceId)}
                  </span>
                </SimpleTooltip>
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

          {!confirming && !renaming && (
            <div className="flex shrink-0 items-center gap-1">
              <DeviceRenameButtonView
                label={isThisDevice ? controlLabel.toLowerCase() : controlLabel}
                onClick={onRename}
              />
              {!isThisDevice && (
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
                  aria-label={`Remove ${namedDevice} from account`}
                  onClick={onRemove}
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

      {traits.hostsProjects && hosts}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          <p className="min-w-0 flex-1 basis-64">
            <span className="font-medium">
              Remove {namedDevice} from your account?
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
              onClick={onCancelRemove}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="xs"
              disabled={revokePending}
              onClick={onRemove}
            >
              {revokePending ? "Removing…" : "Remove device"}
            </Button>
          </div>
        </div>
      ) : (
        exposure
      )}
    </li>
  );
}

// What this machine exposes to the account's other devices, in the
// order a person asks: do they see it, may they drive it, and will it
// be there when they try.
export function ExposureSwitchesView({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}
