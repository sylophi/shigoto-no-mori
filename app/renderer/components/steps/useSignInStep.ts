import { useEffect, useRef } from "react";
import type { SignInStep } from "@shigomori/ui/views/steps/migrationEnded.ts";
import {
  type EnrollmentStep,
  useEnrollment,
} from "@/hooks/account/useEnrollment";

const SIGN_IN: Record<EnrollmentStep, SignInStep> = {
  done: { state: "done", asks: false },
  enrolling: { state: "running", asks: false },
  enroll: { state: "running", asks: false },
  "sign-in": { state: "waiting", asks: true },
};

// The sign-in step both pages share (the migration's and the first
// run's), on this device's enrollment (useEnrollment): while `due`, a
// live session enrolls once by itself, and a lapsed one, or a failed
// enrollment, waits on the button, which tries again.
export function useSignInStep(due: boolean): {
  readonly signIn: SignInStep;
  readonly needsDeviceKey: boolean;
  readonly run: () => void;
} {
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
