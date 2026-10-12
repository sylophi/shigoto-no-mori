import { useEffect, useRef } from "react";
import type { SignInStep } from "@shigomori/ui/views/steps/migrationEnded.ts";
import {
  type EnrollmentStep,
  useEnrollment,
} from "@/hooks/account/useEnrollment";
import { useHasAccountService } from "@/lib/accountService";

const SIGN_IN: Record<EnrollmentStep, SignInStep> = {
  done: { state: "done", asks: false },
  enrolling: { state: "running", asks: false },
  enroll: { state: "running", asks: false },
  "sign-in": { state: "waiting", asks: true },
};

type SignInStepHook = (due: boolean) => {
  // None when the build has no account service: sign-in stays off.
  readonly signIn: SignInStep | null;
  readonly needsDeviceKey: boolean;
  readonly run: () => void;
};

// The sign-in step both pages share (the migration's and the first
// run's), on this device's enrollment (useEnrollment): while `due`, a
// live session enrolls once by itself, and a lapsed one, or a failed
// enrollment, waits on the button, which tries again. A build with no
// account service has no ClerkProvider to enroll under (ClerkGate), so
// it has no sign-in step and calls no Clerk hook; which of the two runs
// is fixed for the page's life.
export const useSignInStep: SignInStepHook = (due) => {
  const hasAccountService = useHasAccountService();
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- which branch runs is fixed for the page's life, so the hooks called never change
  return hasAccountService ? useEnrollmentStep(due) : NO_SIGN_IN;
};

const NO_SIGN_IN = { signIn: null, needsDeviceKey: false, run: () => {} };

function useEnrollmentStep(due: boolean): ReturnType<SignInStepHook> {
  const { step, error, needsDeviceKey, run } = useEnrollment();
  const enrolled = useRef(false);
  useEffect(() => {
    if (!due || step !== "enroll" || enrolled.current) return;
    enrolled.current = true;
    run();
  }, [due, step, run]);
  return {
    signIn:
      error !== null && step === "enroll" ? SIGN_IN["sign-in"] : SIGN_IN[step],
    needsDeviceKey,
    run,
  };
}
