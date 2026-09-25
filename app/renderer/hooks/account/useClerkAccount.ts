// Account hooks that require a mounted ClerkProvider (calling useClerk
// outside one throws at runtime). Kept apart from useAccount.ts so the
// provider requirement is visible at the import site: call these only
// from components the status.configured gates keep off the tree when
// Clerk is absent (see ClerkGate).
import { useAuth, useClerk, useUser } from "@clerk/react";
import { useMutation } from "@tanstack/react-query";

// The mutation key of useClerkSignOut, so a leaf can ask whether a
// sign-out is in flight (useIsMutating) without owning the mutation.
export const CLERK_SIGN_OUT_KEY = ["clerkSignOut"] as const;

// Ends the Clerk session first, then the account layer (best-effort
// hub revoke plus local credential clear). Clerk first, so a device hub
// hiccup in the second step cannot leave a live session that
// ClerkAccountSync would immediately re-enroll. The account half is
// passed as Clerk's sign-out callback: without one, clerk-js
// window-navigates to its after-sign-out URL, reloading the renderer
// mid-flight and racing the revoke, and inside it the revoke lands
// before Clerk announces the session's end. ClerkAccountSync fires the
// same account:signOut off that announcement, and the handlers'
// in-flight guards collapse the two into one revoke.
//
// clerk-js returns before running the callback when its client holds
// no session (useClerkSessionMissing: the sign-in expired while the
// device credential stayed). The button is the only way off the
// account then, so the account half runs on its own if Clerk skipped
// it.
export function useClerkSignOut() {
  const clerk = useClerk();
  return useMutation<void, Error, void>({
    mutationKey: CLERK_SIGN_OUT_KEY,
    mutationFn: async () => {
      let accountSignedOut = false;
      const signOutAccount = async (): Promise<void> => {
        accountSignedOut = true;
        await window.api.account.signOut();
      };
      await clerk.signOut(signOutAccount);
      if (!accountSignedOut) await signOutAccount();
    },
    meta: { errorTitle: "Couldn't sign out" },
  });
}

// Whether Clerk has settled on holding no session. Under a device that
// is still enrolled, that is the person's sign-in having expired (a
// Clerk session has a lifetime, and one that ends while the app is
// closed is never observed by ClerkAccountSync, which leaves the
// credential alone on purpose). Not a session "ending" in that file's
// sense: the caller decides what the absence means for its tree.
// False while Clerk is still loading, since that is not yet an answer.
export function useClerkSessionMissing(): boolean {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && !isSignedIn;
}

// How the signed-in account reads to a person: the email it signs in
// with, else a name, else the username. Null while Clerk is still
// loading the profile, or when it holds no session to have one: the
// Clerk user id the device hub keys on is nothing a person recognises
// as themselves, so the caller decides how to name the account then.
export function useAccountIdentity(): string | null {
  const { user } = useUser();
  return (
    user?.primaryEmailAddress?.emailAddress ||
    user?.fullName ||
    user?.username ||
    null
  );
}
