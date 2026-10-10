// A peer's settings, the parts its own (PeerDeviceSettings.tsx binds
// them): why they aren't there yet, its reported version, and its
// toggles frozen while it doesn't take commands from here.
import type { ReactNode } from "react";
import { peerReadOnlyNote } from "../../lib/commandAccessCopy.ts";
import { cn } from "../../lib/utils.ts";

// This window can't reach the peer: on but not connected yet (a tunnel
// still routing, another network), or simply off.
export function PeerOfflineNoteView({
  label,
  dialing,
}: {
  label: string;
  dialing: boolean;
}) {
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 select-text dark:text-amber-300">
      {dialing
        ? `${label} is on, but this window hasn't connected to it yet. Its settings load once the connection is up. A brand-new tunnel can take a while to route.`
        : `${label} is offline. Its settings live on that device and load when it reconnects.`}
    </p>
  );
}

// Same shape as the offline note, in the neutral family: this is a
// normal permission state, not a warning.
export function PeerReadOnlyNoteView({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground select-text">
      {peerReadOnlyNote(label)}
    </p>
  );
}

export function PeerSettingsLoadingView() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

// The build the device reported, "" before it reports one.
export function PeerVersionLineView({ appVersion }: { appVersion: string }) {
  return appVersion === "" ? (
    <span className="text-muted-foreground">Not reported yet</span>
  ) : (
    `v${appVersion}`
  );
}

// A device's toggles, inert rather than disabled row by row while it
// can be read but not commanded: a read-only visitor needs them
// readable, just not operable.
export function DeviceTogglesView({
  readOnly,
  note,
  saveError,
  children,
}: {
  readOnly: boolean;
  note: ReactNode;
  saveError: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {note}
      <div inert={readOnly} className={cn(readOnly && "opacity-60")}>
        {children}
      </div>
      {saveError}
    </>
  );
}
