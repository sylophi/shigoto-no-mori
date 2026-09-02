import { useAuth, useClerk } from "@clerk/react";
import { LogIn, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccountStatus, useEnroll } from "@/hooks/account/useAccount";
import { DeviceRegistry } from "./DeviceRegistry";
import { EmptyPanel } from "./EmptyPanel";

// "Account": sign in to the relay so this device can reach the
// account's other devices (v2 step 4, slice B). Two states. Signed out
// is one panel with one button. Signed in, the whole page is the device
// registry, which carries the account line (id, headcount, sign-out)
// itself, since that line is the registry's caption and nothing else.
export function AccountSection() {
  const { data: status } = useAccountStatus();
  const signedIn = status?.signedIn === true;

  // Unreachable in practice: the sidebar's Devices button renders only
  // when the account service is configured, so an unconfigured build
  // never navigates here. Render nothing rather than keep explanatory
  // copy alive for a state the nav already prevents.
  if (status !== undefined && !status.configured) return null;

  if (status === undefined) {
    return <p className="text-xs text-muted-foreground/70">Loading&hellip;</p>;
  }

  if (!signedIn) {
    return (
      <EmptyPanel>
        <div className="flex flex-col items-center gap-3">
          <MonitorSmartphone
            aria-hidden
            className="size-6 text-muted-foreground/60"
          />
          <div className="flex flex-col gap-1">
            <p className="font-medium text-foreground">
              Your other machines go here.
            </p>
            <p className="max-w-sm text-xs">
              Sign in and every device on the account shows up in your sidebar,
              worktrees and all. Enrollment stores a device credential in your
              OS keychain.
            </p>
          </div>
          <ClerkSignInButton />
        </div>
      </EmptyPanel>
    );
  }

  return (
    <DeviceRegistry
      accountId={status.accountId}
      localDeviceName={status.deviceName}
    />
  );
}

// Split out so AccountSection itself never calls a Clerk hook: this
// mounts only on the configured (and therefore provider-wrapped) path
// above. Sign-in opens Clerk's embedded modal, and ClerkAccountSync
// turns the resulting session into the enrollment. When Clerk is already
// signed in but the device is not enrolled (the automatic attempt
// failed: relay down, mint error), opening the modal again would do
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
