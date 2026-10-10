// Getting this device enrolled, the one place it is decided: where the
// Clerk session lives that is one call (account:enroll under a fresh
// token), and where it lapsed a sign-in first, which ClerkAccountSync
// turns into the enrollment.
//
// The sign-in button runs it, and so does the move to v3's device key
// step: a device enrolled before device keys reads as signed out until
// it enrolls again, which makes its key pair and registers the public
// half (shared/account/enroll.ts). `needsDeviceKey` says that step is
// due; the migration screen reads `step` and calls `run`, and adds no
// enrollment of its own. Mount it under the ClerkProvider (ClerkGate),
// like every Clerk hook.
import { useAuth, useClerk } from "@clerk/react";
import { useIsMutating } from "@tanstack/react-query";
import {
  ENROLL_MUTATION_KEY,
  useAccountStatus,
  useEnroll,
} from "@/hooks/account/useAccount";
import { hasLocalHost } from "@/lib/localHost";

export type EnrollmentStep =
  // Enrolled, with a key.
  | "done"
  // An enrollment is running, here or in ClerkAccountSync.
  | "enrolling"
  // The session lives: `run` enrolls now.
  | "enroll"
  // The session lapsed: `run` opens the sign-in, and the enrollment
  // follows it.
  | "sign-in";

export function useEnrollment(): {
  step: EnrollmentStep;
  needsDeviceKey: boolean;
  // The last enrollment's failure here, cleared by the next run.
  error: Error | null;
  run: () => void;
} {
  const { data: status } = useAccountStatus();
  const { isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const enroll = useEnroll();
  const enrolling = useIsMutating({ mutationKey: ENROLL_MUTATION_KEY }) > 0;
  const step: EnrollmentStep =
    status?.signedIn === true
      ? "done"
      : enrolling
        ? "enrolling"
        : isSignedIn
          ? "enroll"
          : "sign-in";
  return {
    step,
    needsDeviceKey: status?.needsDeviceKey === true,
    error: enroll.error,
    run: () => {
      if (step === "enroll") {
        enroll.mutate(() => getToken({ skipCache: true }));
      } else if (step === "sign-in") {
        clerk.openSignIn(
          hasLocalHost ? undefined : { forceRedirectUrl: location.href },
        );
      }
    },
  };
}
