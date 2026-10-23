// Account hooks that require a mounted ClerkProvider (calling useClerk
// outside one throws at runtime). Kept apart from useAccount.ts so the
// provider requirement is visible at the import site: call these only
// from components the status.configured gates keep off the tree when
// Clerk is absent (see ClerkGate).
import { useAuth, useClerk, useUser } from "@clerk/react";
import { useMutation } from "@tanstack/react-query";
import { useApi } from "@/lib/runtime/pageApi";

// The mutation key of useClerkSignOut, so a leaf can ask whether a
// sign-out is in flight (useIsMutating) without owning the mutation.
export const CLERK_SIGN_OUT_KEY = ["clerkSignOut"] as const;

// Ends the Clerk session, then the account layer. Clerk first, so a hub
// hiccup in the account half can't leave a live session for
// ClerkAccountSync to re-enroll. The account half is Clerk's sign-out
// callback: without one clerk-js navigates away mid-revoke.
// ClerkAccountSync fires the same signOut off Clerk's announcement, and
// the account handlers' in-flight guard makes it one revoke. With no
// Clerk session (an expired sign-in) clerk-js skips the callback, so it
// runs here.
export function useClerkSignOut() {
  const api = useApi();
  const clerk = useClerk();
  return useMutation<void, Error, void>({
    mutationKey: CLERK_SIGN_OUT_KEY,
    mutationFn: async () => {
      let accountSignedOut = false;
      const signOutAccount = async (): Promise<void> => {
        accountSignedOut = true;
        await api.run(api.account.signOut());
      };
      await clerk.signOut(signOutAccount);
      if (!accountSignedOut) await signOutAccount();
    },
    meta: { errorTitle: "Couldn't sign out" },
  });
}

// Clerk has loaded and holds no session: under an enrolled device, the
// sign-in expired (ClerkAccountSync leaves the credential alone).
export function useClerkSessionMissing(): boolean {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && !isSignedIn;
}

// How the signed-in account reads to a person. Null rather than the
// Clerk user id, which no person recognises.
export function useAccountIdentity(): string | null {
  const { user } = useUser();
  return (
    user?.primaryEmailAddress?.emailAddress ||
    user?.fullName ||
    user?.username ||
    null
  );
}
