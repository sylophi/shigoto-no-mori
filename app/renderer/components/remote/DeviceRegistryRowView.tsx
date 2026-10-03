// One machine's registry row as it is drawn (DeviceRegistryRow holds
// its state and fills the parts that read the app): the mark and name,
// the state line, the project strip, and this device's switches or a
// peer's forwards, or the armed Remove banner in their place. The
// parts that save something (the icon picker, the name field, the
// switches, the forwards) come in as slots, so the live row fills them
// with the components that call the hooks and a scene with their
// views.
import type { ReactNode } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { TunnelState } from "@shared/ipc/modules/hub";
import { Button } from "@/components/ui/button";
import { RowTag } from "@/components/ui/row-tag";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { abbreviateId } from "@/lib/abbreviateId";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { deviceTraits, type DeviceTraits } from "@/lib/remote/deviceTraits";
import { cn } from "@/lib/utils";
import { DeviceRenameButton } from "./DeviceNameFieldView";
import { tunnelNote, type DeviceRowStatus } from "./deviceRegistryStatus";

// What a row calls its machine and what it shows, worked out once for
// the row and for whoever fills its slots, so the two agree.
export function deviceRowFacts({
  deviceId,
  platform,
  isThisDevice,
  name,
  showId,
  status,
}: {
  deviceId: string;
  platform: string;
  isThisDevice: boolean;
  name: string;
  showId: boolean;
  status: DeviceRowStatus;
}): {
  traits: DeviceTraits;
  // What to CALL the machine where the name alone cannot pick it out:
  // the same id fragment the header shows joins it, so the Remove
  // button a screen reader announces and the confirm sentence name one
  // machine rather than two identical ones.
  namedDevice: string;
  // What the row's controls call the machine: this one by its role, a
  // peer by name.
  controlLabel: string;
  // A peer that is not reachable cannot be listing anything right now,
  // so whatever chips it has are its last session's, and the strip
  // says so instead of implying the counts are current. This device's
  // chips are local and always live, whatever its hub socket is doing.
  hostsCached: boolean;
} {
  const traits = deviceTraits(platform);
  const namedDevice = showId ? `${name} ${abbreviateId(deviceId)}` : name;
  return {
    traits,
    namedDevice,
    controlLabel: isThisDevice ? traits.selfLabel : namedDevice,
    hostsCached: !isThisDevice && !status.reachable,
  };
}

export function DeviceRegistryRowView({
  deviceId,
  platform,
  isThisDevice,
  name,
  showId,
  status,
  appVersion,
  tunnel,
  access,
  canForwardPorts,
  renaming,
  onRename,
  confirming,
  revokePending,
  onRemove,
  onCancelRemove,
  iconPicker,
  nameField,
  hosts,
  switches,
  portForwards,
}: {
  deviceId: string;
  // What the device enrolled under (deviceTraits).
  platform: string;
  isThisDevice: boolean;
  name: string;
  // Another row wears the same name, so the id has to tell them apart.
  showId: boolean;
  status: DeviceRowStatus;
  // The app version this machine runs, "" when unknown.
  appVersion: string;
  // THIS device's tunnel endpoint state, on the this-device row only.
  tunnel: TunnelState | undefined;
  // Whether THIS device may run commands on the peer. Ignored on the
  // this-device row.
  access: Pick<CommandAccess, "granted" | "isLoading">;
  // Whether this client can forward ports at all (the app can, a
  // browser cannot).
  canForwardPorts: boolean;
  // The name is open for editing, which hides the tag and the actions.
  renaming: boolean;
  onRename?: () => void;
  // Remove is armed (or running), so the banner takes the controls'
  // place.
  confirming: boolean;
  revokePending: boolean;
  onRemove?: () => void;
  onCancelRemove?: () => void;
  // The row's mark, which opens the icon picker.
  iconPicker: ReactNode;
  // The name, as text or as its editor.
  nameField: ReactNode;
  // The project strip, drawn for a machine that hosts projects.
  hosts: ReactNode;
  // This device's two switches, drawn for a machine others can reach.
  switches: ReactNode;
  // A peer's forwards, drawn where this client can forward to it.
  portForwards: ReactNode;
}) {
  const { traits, namedDevice, controlLabel } = deviceRowFacts({
    deviceId,
    platform,
    isThisDevice,
    name,
    showId,
    status,
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
                <span
                  title={deviceId}
                  className="font-mono text-2xs text-muted-foreground/70 select-text"
                >
                  {abbreviateId(deviceId)}
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

          {!confirming && !renaming && (
            <div className="flex shrink-0 items-center gap-1">
              <DeviceRenameButton
                label={isThisDevice ? controlLabel.toLowerCase() : controlLabel}
                onClick={() => onRename?.()}
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
                  onClick={() => onRemove?.()}
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
              onClick={() => onCancelRemove?.()}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="xs"
              disabled={revokePending}
              onClick={() => onRemove?.()}
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
          <div className="flex flex-col gap-3">{switches}</div>
        )
      ) : (
        // Forwarding binds a real listener on THIS machine, so it is
        // app-only, and against a machine that serves calls, so never a
        // browser. The strip renders itself away when it can neither
        // start one nor show a live one.
        canForwardPorts && traits.exposable && portForwards
      )}
    </li>
  );
}
