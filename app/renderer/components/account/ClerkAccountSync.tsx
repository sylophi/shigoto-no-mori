// Keeps the Clerk session and the hub device credential in step, on
// both shells (mounted inside the ClerkProvider by ClerkGate). Clerk
// owns "who is signed in", the account layer owns "this device is
// enrolled". The transitions this component drives:
//
// - Signed in, no credential: enroll with a fresh token (skipCache, so
//   the hub never sees one mid-expiry), once per Clerk user per session
//   (armedFor). Having seen the device enrolled counts as that attempt:
//   a credential that goes while the session lives was signed out, and
//   enrolling again would undo it.
// - Signed in as a different user than the credential's: sign the
//   account layer out first (the hub refuses a cross-account re-enroll
//   of the same deviceId), and the effect re-runs into the enroll
//   branch.
// - Clerk session ended: sign the account layer out too, but only for a
//   session this process saw (sawSession). No session at boot isn't a
//   sign-out: the credential is long-lived and independent of Clerk, and
//   revoking it on a hunch would destroy real state.
// - The hub closes this device's socket as revoked (it was removed from
//   the account on another device): sign out in full, Clerk session
//   included, once per block, so a failing sign-out doesn't loop. A
//   window with a shared sign-in (status.sharedSignIn, a --clone-login
//   dev profile) drops the account layer only, since ending the Clerk
//   session would sign every clone out, and the enroll guard keeps it
//   from enrolling again on the spot. Any other block (a refused ticket,
//   a superseded socket) changes nothing here.
import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";
import {
  useAccountSignOut,
  useAccountStatus,
  useEnroll,
} from "@/hooks/account/useAccount";
import { credentialRevoked } from "@shared/remote/supervisor";
import { useClerkSignOut } from "@/hooks/account/useClerkAccount";
import { useHubBlock } from "@/hooks/remote/useHubStatus";
import { toast } from "@/lib/toast";
import { useFinishRedirectSignIn } from "@/hooks/account/useEnrollment";

export function ClerkAccountSync() {
  useFinishRedirectSignIn();
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
  const armedFor = useRef<string | null>(null);
  const sawSession = useRef(false);

  const block = useHubBlock();
  const revoked = block !== null && credentialRevoked(block);
  const sharedSignIn = status?.sharedSignIn === true;
  const clerkSignOut = useClerkSignOut();
  const clerkSignOutMutate = clerkSignOut.mutate;
  const signOutNow = sharedSignIn ? signOutMutate : clerkSignOutMutate;
  // Either sign-out in flight. A self sign-out revokes this device on
  // the hub, which closes this device's own socket as revoked before
  // the local credential clears, so the block below is seen mid
  // sign-out too, and must not read as a removal by someone else.
  const signingOut = signOutPending || clerkSignOut.isPending;
  // Whether this block already got its sign-out: the socket stays
  // blocked while the sign-out runs, and leaves that phase once it has.
  const signedOutForBlock = useRef(false);
  useEffect(() => {
    if (!revoked) {
      signedOutForBlock.current = false;
      return;
    }
    if (!enrolled || signedOutForBlock.current || signingOut) return;
    signedOutForBlock.current = true;
    // The one word the user gets on why every peer just vanished: the
    // registry's own banner says it too, but that page is replaced by
    // the signed-out panel the moment the sign-out lands.
    toast.warning("This device was removed from the account", {
      id: "account:revoked",
      description: "It has signed out. Sign in again to enroll it afresh.",
      duration: 15_000,
    });
    signOutNow();
  }, [revoked, enrolled, signingOut, signOutNow]);

  useEffect(() => {
    if (!isLoaded || enrolled === undefined || !configured) return;
    if (isSignedIn && userId) {
      sawSession.current = true;
      if (enrolled && accountId === userId) {
        armedFor.current = userId;
      } else if (enrolled) {
        // Stale other-account credential (a failed sign-out, Clerk
        // account switching): release it before enrolling.
        if (!signOutPending) signOutMutate();
      } else if (armedFor.current !== userId) {
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
