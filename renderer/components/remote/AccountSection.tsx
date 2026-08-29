import { useAuth, useClerk } from "@clerk/react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useAccountStatus, useEnroll } from "@/hooks/account/useAccount";
import { abbreviateId } from "@/lib/abbreviateId";
import { DeviceRegistry } from "./DeviceRegistry";

// "Account": sign in to the relay so this device can reach the
// account's other devices (v2 step 4, slice B). Two states. Signed out
// is a single button under one line of copy. Signed in, the account
// itself is one thin line -- an id and nothing else, because a relay
// account has no other properties -- and everything below it is the
// device registry, which is what the page is actually for. Sign out
// lives on this device's row there, next to the machine it signs out.
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
      <section className="space-y-3">
        <div>
          <SectionHeading className="mb-1">Account</SectionHeading>
          <p className="text-xs text-muted-foreground">
            Sign in to reach this account&apos;s other devices through the
            relay. Enrollment stores a device credential in your OS keychain.
          </p>
        </div>
        <ClerkSignInButton />
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <SectionHeading>Account</SectionHeading>
        <span className="font-mono text-xs text-foreground">
          {abbreviateId(status.accountId)}
        </span>
      </div>
      <DeviceRegistry localDeviceName={status.deviceName} />
    </div>
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
        variant="outline"
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
    <Button variant="outline" size="sm" onClick={() => clerk.openSignIn()}>
      <LogIn />
      Sign in
    </Button>
  );
}
