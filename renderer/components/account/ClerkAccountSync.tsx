// Keeps the Clerk session and the relay device credential in step, on
// both shells (mounted inside the ClerkProvider by ClerkGate). Clerk
// owns "who is signed in"; the account layer owns "this device is
// enrolled". The two transitions this component drives:
//
// - Clerk signed in, no credential stored: mint a fresh session token
//   (skipCache, so the relay never sees one mid-expiry) and exchange it
//   for a device credential via account:enroll. One attempt per mount
//   (the mutation leaves isIdle) — a failure (relay down, mint failed)
//   surfaces as the mutation's error toast rather than a retry loop,
//   and the next sign-in or relaunch tries again. Main's own in-flight
//   guard is the authoritative dedupe for re-fired effects.
// - Clerk signed out, credential still stored: sign the account layer
//   out too (best-effort relay revoke plus local clear), so a session
//   ended from Clerk's own UI or another Clerk surface also drops the
//   device credential.
import { useEffect } from "react";
import { useAuth } from "@clerk/react";
import {
  useAccountSignOut,
  useAccountStatus,
  useEnroll,
} from "@/hooks/account/useAccount";

export function ClerkAccountSync() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { data: status } = useAccountStatus();
  const enroll = useEnroll();
  const signOut = useAccountSignOut();
  const enrollIdle = enroll.isIdle;
  const enrollMutate = enroll.mutate;
  const signOutMutate = signOut.mutate;
  const configured = status?.configured === true;
  const enrolled = status?.signedIn;

  useEffect(() => {
    if (!isLoaded || enrolled === undefined || !configured) return;
    if (isSignedIn && !enrolled) {
      if (enrollIdle) enrollMutate(() => getToken({ skipCache: true }));
    } else if (!isSignedIn && enrolled) {
      signOutMutate();
    }
  }, [
    isLoaded,
    isSignedIn,
    enrolled,
    configured,
    enrollIdle,
    enrollMutate,
    signOutMutate,
    getToken,
  ]);

  return null;
}
