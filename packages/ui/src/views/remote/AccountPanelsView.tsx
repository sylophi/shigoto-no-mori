// The account page's states before the registry, drawn
// (AccountSection.tsx picks one): loading, signed out, and a build
// with no account service.
import type { ReactNode } from "react";
import { CloudOff, MonitorSmartphone, type LucideIcon } from "lucide-react";
import { ACCOUNT_ENV } from "@shigomori/contracts/accountServiceConfig";
import { EmptyPanel } from "../../primitives/empty-panel.tsx";

export function AccountLoadingView() {
  return <p className="text-xs text-muted-foreground/70">Loading&hellip;</p>;
}

export function SignedOutPanelView({
  desktop,
  signIn,
}: {
  // A desktop app keeps its credential in the OS keychain, a browser
  // enrolls as a device of its own.
  desktop: boolean;
  signIn: ReactNode;
}) {
  return (
    <StatePanel
      icon={MonitorSmartphone}
      title="Your other machines go here."
      action={signIn}
    >
      <p className="max-w-sm text-xs">
        Sign in and every device on the account shows up in your sidebar,
        worktrees and all.{" "}
        {desktop
          ? "Enrollment stores a device credential in your OS keychain."
          : "This browser enrolls as a device of its own."}
      </p>
    </StatePanel>
  );
}

// The chrome the two empty states share: an icon, a heading with its
// copy grouped tight beneath it, and an optional action set apart.
function StatePanel({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    // The page runs full width for the registry's rows. A centred
    // placeholder stretched edge to edge is not a design, so the two
    // empty states keep the prose cap.
    <div className="max-w-3xl">
      <EmptyPanel>
        <div className="flex flex-col items-center gap-3">
          <Icon aria-hidden className="size-6 text-muted-foreground/60" />
          <div className="flex flex-col gap-1">
            <p className="font-medium text-foreground">{title}</p>
            {children}
          </div>
          {action}
        </div>
      </EmptyPanel>
    </div>
  );
}

// The .env.local hint is dev-only: a packaged build sources the account
// service from its build environment alone (hub/README.md), so the
// advice would mislead there.
export function NotConfiguredPanelView({
  isDev,
  desktop,
}: {
  isDev: boolean;
  // A desktop app restarts, a hostless client's dev server does.
  desktop: boolean;
}) {
  return (
    <StatePanel icon={CloudOff} title="Device sync isn't set up in this build.">
      <p className="max-w-sm text-xs">
        The account service settings{" "}
        <code className="font-mono">{ACCOUNT_ENV.hubUrl}</code> and{" "}
        <code className="font-mono">{ACCOUNT_ENV.publishableKey}</code> are
        missing, so sign-in is unavailable and other devices cannot appear here.
      </p>
      {isDev && (
        <p className="max-w-sm text-xs">
          Dev builds read them from a{" "}
          <code className="font-mono">.env.local</code> in the checkout the app
          was started from (or the launch environment). Add the file and restart{" "}
          {desktop ? "the app" : "the dev server"}.
        </p>
      )}
    </StatePanel>
  );
}
