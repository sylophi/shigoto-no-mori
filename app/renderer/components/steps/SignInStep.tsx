import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SignInStep as SignInStepShown } from "@shigomori/ui/views/steps/migrationEnded.ts";
import {
  type EnrollmentStep,
  useEnrollment,
} from "@/hooks/account/useEnrollment";
import { useHasAccountService } from "@/lib/accountService";

const SIGN_IN: Record<EnrollmentStep, SignInStepShown> = {
  done: { state: "done", asks: false },
  enrolling: { state: "running", asks: false },
  enroll: { state: "running", asks: false },
  "sign-in": { state: "waiting", asks: true },
};

export interface SignInStepState {
  // None when the build has no account service (sign-in stays off), or
  // before the device key is due.
  readonly signIn: SignInStepShown | null;
  readonly run: () => void;
}

type Steps = (step: SignInStepState) => ReactNode;

// The migration page's sign-in step, shown from the moment the device
// key is due, and done once it no longer is. A build
// with no account service has no ClerkProvider to enroll under
// (ClerkGate), so it has no sign-in step and calls no Clerk hook. Which
// of the two is drawn is fixed for the page's life.
export function SignInStep({ render }: { render: Steps }) {
  return useHasAccountService() ? (
    <EnrollmentStep render={render} />
  ) : (
    render(NO_SIGN_IN)
  );
}

const NO_SIGN_IN: SignInStepState = {
  signIn: null,
  run: () => {},
};

function EnrollmentStep({ render }: { render: Steps }) {
  const [keyDue, setKeyDue] = useState(false);
  const step = useSignInStep(keyDue);
  if (step.needsDeviceKey && !keyDue) setKeyDue(true);
  return render({ signIn: keyDue ? step.signIn : null, run: step.run });
}

// On this device's enrollment (useEnrollment): while `due`, a live
// session enrolls once by itself, and a lapsed one, or a failed
// enrollment, waits on the button, which tries again.
function useSignInStep(due: boolean) {
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
