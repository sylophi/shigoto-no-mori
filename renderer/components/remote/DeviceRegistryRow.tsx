// One machine on the account, as a card: what it is, what state it is
// in, what it hosts, and the two things this host decides about it
// (whether it may run commands here, and whether it stays on the
// account at all).
//
// The row is the unit of the page. Everything about a device is inside
// its own card -- the rename for this device, the keep-reachable toggle
// for this device, the destructive confirm for a peer -- so nothing
// about a machine ever floats in a section of its own where it has to
// re-name the machine it applies to.
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Trash2 } from "lucide-react";
import type { TunnelState } from "@shared/ipc/modules/relay";
import type { DeviceInfo } from "@shared/relay/protocol";
import { ClerkSignOutButton } from "@/components/account/ClerkSignOutButton";
import { Button } from "@/components/ui/button";
import { StatusDot, TONE_PILL } from "@/components/ui/status-dot";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { cn } from "@/lib/utils";
import { DeviceHosts } from "./DeviceHosts";
import { DeviceNameField, DeviceRenameButton } from "./DeviceNameField";
import { KeepReachableToggle } from "./KeepReachableToggle";
import type { HostChip } from "./deviceHostChips";
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
}: {
  device: DeviceInfo;
  isThisDevice: boolean;
  // This device's stored name, which setDeviceName writes locally while
  // the relay registry keeps the name it enrolled under. The local one
  // is the truth the user just typed, so the row shows it.
  localDeviceName: string;
  // Derived once by the registry, which needs the same reading for its
  // summary line, so the count and the dots cannot disagree.
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
  // the this-device row only. "up" is a muted marker beside the name;
  // the phases that mean "peers off this network cannot reach me" get
  // one quiet line under the id (tunnelNote), because that fact is
  // what decides whether the other machine's forest view can load.
  tunnel: TunnelState | undefined;
}) {
  const navigate = useNavigate();
  // Armed inline instead of in a modal: the sentence names the machine
  // and the row is right there to check it against, which a dialog
  // covering the list cannot offer. The shared two-step confirm carries
  // the armed flag, so an untouched banner disarms itself.
  const revoke = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // The banner outlives the arming while the revoke is in flight, so
  // the row shows "Revoking…" where the confirm button was instead of
  // snapping back to its actions.
  const confirming = revoke.armed || revokePending;
  // Held here rather than inside the name field so the Rename trigger
  // can sit with the row's other actions while the editor opens on the
  // name itself.
  const [renaming, setRenaming] = useState(false);
  const note = tunnelNote(tunnel);

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {isThisDevice ? (
              <DeviceNameField
                deviceName={localDeviceName}
                label="This device"
                editing={renaming}
                onEditingChange={setRenaming}
              />
            ) : (
              <span className="truncate text-sm font-medium">
                {device.name}
              </span>
            )}
            {isThisDevice && (
              <span className="text-xs text-muted-foreground">
                (this device)
              </span>
            )}
            {tunnel === "up" && (
              <span className="text-xs text-muted-foreground">tunnel</span>
            )}
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full px-2 py-0.5",
                TONE_PILL[status.tone],
              )}
            >
              <StatusDot
                tone={status.tone}
                label={<span className="text-xs">{status.label}</span>}
              />
            </span>
          </div>

          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {device.platform} &middot; {device.deviceId}
            {appVersion !== "" && <> &middot; v{appVersion}</>}
          </span>

          {note !== null && (
            <span className="text-[11px] text-muted-foreground">{note}</span>
          )}

          <DeviceHosts
            chips={chips}
            loading={chipsLoading}
            // A machine that is not reachable cannot be listing
            // anything right now, so whatever chips it has are its last
            // session's, and the strip says so instead of implying the
            // counts are current.
            cached={!status.reachable && chips.length > 0}
          />
        </div>

        {!confirming && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {isThisDevice ? (
              <>
                {!renaming && (
                  <DeviceRenameButton
                    label="This device"
                    onClick={() => setRenaming(true)}
                  />
                )}
                {/* Self-revoke is not offered: it would invalidate this
                    app's own credential, and with the Clerk session
                    still live ClerkAccountSync would re-enroll the
                    machine straight back onto the account. Sign out is
                    the honest version of the same intent -- it ends the
                    session first, then clears the credential. */}
                <ClerkSignOutButton />
              </>
            ) : (
              <>
                <span className="text-[10px] text-muted-foreground">
                  {granted ? "Can run commands here" : "Read-only"}
                </span>
                <Button
                  // Outline in BOTH states: a ghost button sitting
                  // right after its own state text reads as more of
                  // that sentence ("Can run commands here Revoke
                  // commands") instead of as the control that changes
                  // it.
                  variant="outline"
                  size="xs"
                  disabled={grantPending}
                  onClick={granted ? onRevokeCommands : onGrant}
                >
                  {granted ? "Revoke commands" : "Allow commands"}
                </Button>
                {status.reachable && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      void navigate({
                        to: "/devices/$deviceId",
                        params: { deviceId: device.deviceId },
                      })
                    }
                  >
                    View forest
                    <ArrowRight />
                  </Button>
                )}
                <Button
                  variant="ghost-destructive"
                  size="xs"
                  onClick={() => revoke.trigger(onRevokeDevice)}
                >
                  <Trash2 />
                  Revoke device
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {isThisDevice && <KeepReachableToggle />}

      {confirming && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          <p className="min-w-0 flex-1 basis-64">
            <span className="font-medium">Revoke {device.name}?</span> It loses
            access the moment it next connects, and its cached projects
            disappear from your sidebar. Worktrees and files on the machine
            itself are left alone. Pair again with a new code to undo.
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
              {revokePending ? "Revoking…" : "Revoke device"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
