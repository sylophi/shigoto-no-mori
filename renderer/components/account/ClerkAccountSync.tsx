// Keeps the Clerk session and the relay device credential in step, on
// both shells (mounted inside the ClerkProvider by renderer/index.tsx
// and web/app/boot.tsx). Clerk owns "who is signed in"; the account
// layer owns "this device is enrolled". The two transitions this
// component drives:
//
// - Clerk signed in, no credential stored: mint a fresh session token
//   (skipCache, so the relay never sees one mid-expiry) and exchange it
//   for a device credential via account:enroll. One attempt per
//   transition — an enroll failure (relay down) surfaces as the
//   mutation's error toast rather than a retry loop, and the next
//   sign-in or relaunch tries again.
// - Clerk signed out, credential still stored: sign the account layer
//   out too (best-effort relay revoke plus local clear), so a session
//   ended from Clerk's own UI or another Clerk surface also drops the
//   device credential.
import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";
import { useAccountStatus, useEnroll } from "@/hooks/account/useAccount";

export function ClerkAccountSync() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { data: status } = useAccountStatus();
  const enroll = useEnroll();
  // Latches the single enroll attempt per signed-in transition. A ref,
  // not state: StrictMode's double effect run must see the first run's
  // latch, and a failed attempt must not re-render into a retry.
  const enrollAttempted = useRef(false);

  const clerkSignedIn = isLoaded ? isSignedIn === true : undefined;
  const enrolled = status?.signedIn;
  const configured = status?.configured === true;
  const enrollMutate = enroll.mutate;

  useEffect(() => {
    if (clerkSignedIn === undefined || enrolled === undefined || !configured) {
      return;
    }
    if (clerkSignedIn && !enrolled) {
      if (enrollAttempted.current) return;
      enrollAttempted.current = true;
      void getToken({ skipCache: true }).then((token) => {
        if (token) enrollMutate(token);
      });
    } else {
      enrollAttempted.current = false;
      if (!clerkSignedIn && enrolled) {
        void window.api.account.signOut();
      }
    }
  }, [clerkSignedIn, enrolled, configured, getToken, enrollMutate]);

  return null;
}
