// A peer's pages when its session is not up, drawn (RemoteScope.tsx
// decides which): the page under a banner, or no page at all.
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { ConfirmDestructiveButton } from "../../primitives/confirm-destructive-button.tsx";

export function RemoteScopeFrameView({
  banner,
  children,
}: {
  banner: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {banner}
      {/* The page keeps this slot whether or not the banner is up,
          so a blip re-renders it in place instead of remounting it,
          which is the entire point of holding the api. */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

// No session has ever been open on the device in this window, so there
// is no page to stand under a banner.
export function UnreachableDeviceView({
  label,
  action,
}: {
  label: string;
  action: ReactNode;
}) {
  return (
    <CenteredMessage className="flex-col gap-3">
      {label}
      {action}
    </CenteredMessage>
  );
}

// The same message over a page that is still standing: what is on
// screen is the last thing the device sent, and anything acted on it
// will fail until the session is back.
export function UnreachableBannerView({
  label,
  action,
}: {
  label: string;
  action: ReactNode;
}) {
  return (
    <ScopeBannerView action={action}>
      {label} Showing the last state it sent.
    </ScopeBannerView>
  );
}

// A line over a peer's pages with what to do about it. Over pages that
// stay live, it says what of a peer on another release of the app
// can't be used from here (outdatedCopy.ts), with the update that ends
// it when this device can ask for one.
export function ScopeBannerView({
  action,
  children,
}: {
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300 phone:px-4">
      <span className="min-w-0 flex-1 select-text">{children}</span>
      {action}
    </div>
  );
}

// Updates the older of two devices from a note that names it, armed
// first where the press asks twice. It holds while the device is on its
// way into the update.
export function UpdateDeviceButtonView({
  armed,
  updating,
  onClick,
}: {
  armed: boolean;
  updating: boolean;
  onClick: () => void;
}) {
  return (
    <ConfirmDestructiveButton
      variant="outline"
      armed={armed}
      pending={updating}
      pendingLabel="Updating…"
      idleLabel="Update"
      icon={<RefreshCw aria-hidden />}
      onClick={onClick}
    />
  );
}

// The account page lists every device with its state. A hostless
// client calls it Devices: there it is the home page, not a section of
// Settings.
export function OpenDevicesButtonView({
  desktop,
  onClick,
}: {
  desktop: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {desktop ? "Open account page" : "Open Devices"}
    </Button>
  );
}
