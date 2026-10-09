import { useAuth, useClerk } from "@clerk/react";
import { useEnroll } from "@/hooks/account/useAccount";
import { hasLocalHost } from "@/lib/localHost";
import { SignInButtonView } from "./AccountButtonsView";

// The shared sign-in affordance, beside ClerkSignOutButton for the
// same reason: no shell layout ever calls a Clerk hook itself. Mount
// it only on the configured (and therefore provider-wrapped) path,
// which is AccountSection's signed-out panel and the registry's
// blocked banner (a peer removed this device from the account), so
// the way back onto an account is one button and not two spellings.
// Sign-in opens Clerk's embedded modal, and ClerkAccountSync
// turns the resulting session into the enrollment. When Clerk is already
// signed in but the device is not enrolled (the automatic attempt
// failed: hub down, mint error), opening the modal again would do
// nothing, so the button becomes the manual enrollment retry instead.
export function ClerkSignInButton() {
  const clerk = useClerk();
  const { isSignedIn, getToken } = useAuth();
  const enroll = useEnroll();
  if (isSignedIn) {
    return (
      <SignInButtonView
        retry
        pending={enroll.isPending}
        onClick={() => enroll.mutate(() => getToken({ skipCache: true }))}
      />
    );
  }
  return (
    <SignInButtonView
      retry={false}
      pending={false}
      onClick={() =>
        clerk.openSignIn(
          hasLocalHost ? undefined : { forceRedirectUrl: location.href },
        )
      }
    />
  );
}
