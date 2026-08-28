// Account hooks that require a mounted ClerkProvider (calling useClerk
// outside one throws at runtime). Kept apart from useAccount.ts so the
// provider requirement is visible at the import site: call these only
// from components the status.configured gates keep off the tree when
// Clerk is absent (see ClerkGate).
import { useClerk } from "@clerk/react";
import { useMutation } from "@tanstack/react-query";

// Ends the Clerk session first, then the account layer (best-effort
// relay revoke plus local credential clear). Clerk first, so a relay
// hiccup in the second step cannot leave a live session that
// ClerkAccountSync would immediately re-enroll.
export function useClerkSignOut() {
  const clerk = useClerk();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      await clerk.signOut();
      await window.api.account.signOut();
    },
    meta: { errorTitle: "Couldn't sign out" },
  });
}
