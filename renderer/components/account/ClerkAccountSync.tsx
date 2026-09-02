// Keeps the Clerk session and the hub device credential in step, on
// both shells (mounted inside the ClerkProvider by ClerkGate). Clerk
// owns "who is signed in", the account layer owns "this device is
// enrolled". The transitions this component drives:
//
// - Clerk signed in, no credential stored: mint a fresh session token
//   (skipCache, so the device hub never sees one mid-expiry) and exchange it
//   for a device credential via account:enroll. One automatic attempt
//   per Clerk user per session (armedFor), re-armed by a sign-out. A
//   failure (hub down, mint failed) surfaces as the mutation's error
//   toast, and the account UI offers a manual retry (the enroll-retry
//   buttons in AccountSection / LoginPage). Main's in-flight guard is
//   the authoritative dedupe for re-fired effects.
// - Clerk signed in as a DIFFERENT user than the stored credential:
//   sign the account layer out first (the device hub refuses a cross-account
//   re-enroll of the same deviceId), then the effect re-runs into the
//   enroll branch.
// - Clerk session ended: sign the account layer out too, but only for
//   a session this process actually observed (sawSession). "No session
//   at boot" is NOT a sign-out: the stored credential is long-lived and
//   independent of Clerk (a pre-Clerk upgrade, a cleared Clerk token
//   store), and revoking it plus the command grants on a hunch would
//   destroy real state. Such a mismatch instead resolves the moment the
//   user acts (signs in → mismatch/enroll branch handle it).
import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";
import {
  useAccountSignOut,
  useAccountStatus,
  useEnroll,
} from "@/hooks/account/useAccount";

export function ClerkAccountSync() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { data: status } = useAccountStatus();
  const enroll = useEnroll();
  const signOut = useAccountSignOut();
  const enrollMutate = enroll.mutate;
  const signOutMutate = signOut.mutate;
  const signOutPending = signOut.isPending;
  const configured = status?.configured === true;
  const enrolled = status?.signedIn;
  const accountId = status?.accountId;
  // The Clerk user this process has already auto-attempted to enroll,
  // so a failed attempt doesn't retry-loop off unrelated status churn.
  // Cleared when the session ends, so sign-out → sign-in re-arms.
  const armedFor = useRef<string | null>(null);
  // Whether this process ever observed a live Clerk session, gating the
  // destructive sign-out branch to sessions that ended in-process.
  const sawSession = useRef(false);

  useEffect(() => {
    if (!isLoaded || enrolled === undefined || !configured) return;
    if (isSignedIn && userId) {
      sawSession.current = true;
      if (enrolled && accountId !== userId) {
        // Stale other-account credential (a failed sign-out, Clerk
        // account switching): release it before enrolling.
        if (!signOutPending) signOutMutate();
      } else if (!enrolled && armedFor.current !== userId) {
        armedFor.current = userId;
        enrollMutate(() => getToken({ skipCache: true }));
      }
    } else if (!isSignedIn) {
      armedFor.current = null;
      if (sawSession.current) {
        sawSession.current = false;
        if (enrolled && !signOutPending) signOutMutate();
      }
    }
  }, [
    isLoaded,
    isSignedIn,
    userId,
    enrolled,
    accountId,
    configured,
    signOutPending,
    enrollMutate,
    signOutMutate,
    getToken,
  ]);

  return null;
}
