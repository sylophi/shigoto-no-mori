import { useAuth, useClerk } from "@clerk/react";
import {
  CloudOff,
  LogIn,
  MonitorSmartphone,
  type LucideIcon,
} from "lucide-react";
import { ACCOUNT_ENV } from "@shared/account/serviceConfig";
import { Button } from "@/components/ui/button";
import { useAccountStatus, useEnroll } from "@/hooks/account/useAccount";
import { DeviceRegistry } from "./DeviceRegistry";
import { EmptyPanel } from "./EmptyPanel";

// "Account": sign in to the device hub so this device can reach the
// account's other devices. Three states. Not
// configured (no account service in this build's launch env) is one
// panel that says so and how to fix it. Signed out is one panel with
// one button. Signed in, the whole page is the device registry, which
// carries the account line (who is signed in, sign-out) itself, since
// that line is the registry's caption and nothing else.
export function AccountSection() {
  const { data: status } = useAccountStatus();

  if (status === undefined) {
    return <p className="text-xs text-muted-foreground/70">Loading&hellip;</p>;
  }

  if (!status.configured) {
    return <NotConfiguredPanel />;
  }

  if (!status.signedIn) {
    return (
      <StatePanel
        icon={MonitorSmartphone}
        title="Your other machines go here."
        action={<ClerkSignInButton />}
      >
        <p className="max-w-sm text-xs">
          Sign in and every device on the account shows up in your sidebar,
          worktrees and all. Enrollment stores a device credential in your OS
          keychain.
        </p>
      </StatePanel>
    );
  }

  return <DeviceRegistry accountId={status.accountId} />;
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
  action?: React.ReactNode;
  children: React.ReactNode;
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
function NotConfiguredPanel() {
  return (
    <StatePanel icon={CloudOff} title="Device sync isn't set up in this build.">
      <p className="max-w-sm text-xs">
        The account service settings{" "}
        <code className="font-mono">{ACCOUNT_ENV.hubUrl}</code> and{" "}
        <code className="font-mono">{ACCOUNT_ENV.publishableKey}</code> are
        missing, so sign-in is unavailable and other devices cannot appear here.
      </p>
      {window.api.isDev && (
        <p className="max-w-sm text-xs">
          Dev builds read them from a{" "}
          <code className="font-mono">.env.local</code> in the checkout the app
          was started from (or the launch environment). Add the file and restart
          the app.
        </p>
      )}
    </StatePanel>
  );
}

// Split out so AccountSection itself never calls a Clerk hook: this
// mounts only on the configured (and therefore provider-wrapped) path
// above. Sign-in opens Clerk's embedded modal, and ClerkAccountSync
// turns the resulting session into the enrollment. When Clerk is already
// signed in but the device is not enrolled (the automatic attempt
// failed: hub down, mint error), opening the modal again would do
// nothing, so the button becomes the manual enrollment retry instead.
function ClerkSignInButton() {
  const clerk = useClerk();
  const { isSignedIn, getToken } = useAuth();
  const enroll = useEnroll();
  if (isSignedIn) {
    return (
      <Button
        size="sm"
        disabled={enroll.isPending}
        onClick={() => enroll.mutate(() => getToken({ skipCache: true }))}
      >
        <LogIn />
        {enroll.isPending ? "Enrolling…" : "Retry enrollment"}
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={() => clerk.openSignIn()}>
      <LogIn />
      Sign in
    </Button>
  );
}
