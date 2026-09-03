// Account hooks that require a mounted ClerkProvider (calling useClerk
// outside one throws at runtime). Kept apart from useAccount.ts so the
// provider requirement is visible at the import site: call these only
// from components the status.configured gates keep off the tree when
// Clerk is absent (see ClerkGate).
import { useClerk, useUser } from "@clerk/react";
import { useMutation } from "@tanstack/react-query";

// Ends the Clerk session first, then the account layer (best-effort
// hub revoke plus local credential clear). Clerk first, so a device hub
// hiccup in the second step cannot leave a live session that
// ClerkAccountSync would immediately re-enroll. The account half is
// passed as Clerk's sign-out callback: without one, clerk-js
// window-navigates to its after-sign-out URL, reloading the renderer
// mid-flight and racing the revoke. ClerkAccountSync fires the same
// account:signOut off the session-ended transition, and the handlers'
// in-flight guards collapse the two into one revoke.
export function useClerkSignOut() {
  const clerk = useClerk();
  return useMutation<void, Error, void>({
    mutationFn: () =>
      clerk.signOut(async () => {
        await window.api.account.signOut();
      }),
    meta: { errorTitle: "Couldn't sign out" },
  });
}

// How the signed-in account reads to a person: the email it signs in
// with, else a name, else the username. The Clerk user id is what the
// device hub keys on, but it is an opaque string nobody recognises as
// themselves, so it is only the fallback while Clerk is still loading
// the user (or when the profile carries none of the above). The caller
// supplies that fallback so the id abbreviation rule stays in one place.
export function useAccountIdentity(fallback: string): string {
  const { user } = useUser();
  return (
    user?.primaryEmailAddress?.emailAddress ||
    user?.fullName ||
    user?.username ||
    fallback
  );
}
