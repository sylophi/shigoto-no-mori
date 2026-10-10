// A peer's pages when its session is not up, drawn (RemoteScope.tsx
// decides which): the page under a banner, or no page at all.
import type { ReactNode } from "react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { CenteredMessage } from "@shigomori/ui/primitives/centered-message.tsx";

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
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
      <span className="min-w-0 flex-1 select-text">
        {label} Showing the last state it sent.
      </span>
      {action}
    </div>
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
