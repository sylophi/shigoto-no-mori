import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMigration } from "@/hooks/useMigration";
import { MigrationView } from "@shigomori/ui/views/steps/MigrationView.tsx";
import {
  migrationEnded,
  type SignInStep,
} from "@shigomori/ui/views/steps/migrationEnded.ts";
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

// The v3 migration as this machine's shell serves it, in place of the app
// (the /migration route), with this device's enrollment for its key
// (useEnrollment) as its sign-in: by itself while the session lives, a
// button once it has lapsed. With every step done it opens the app, and
// with nothing to migrate at once.
export function MigrationPage() {
  const migration = useMigration() ?? undefined;
  const enrollment = useEnrollment();
  // Shown from the moment it is due, and done once it no longer is.
  const [keyDue, setKeyDue] = useState(false);
  if (enrollment.needsDeviceKey && !keyDue) setKeyDue(true);
  // A failed enrollment waits on the button, which tries again.
  const signIn = !keyDue
    ? null
    : enrollment.error !== null && enrollment.step === "enroll"
      ? SIGN_IN["sign-in"]
      : SIGN_IN[enrollment.step];
  const navigate = useNavigate();
  const { open } =
    migration === undefined
      ? { open: false }
      : migrationEnded(migration, signIn);

  // A live session enrolls once, by itself.
  const { step, run } = enrollment;
  const enrolled = useRef(false);
  useEffect(() => {
    if (!keyDue || step !== "enroll" || enrolled.current) return;
    enrolled.current = true;
    run();
  }, [keyDue, step, run]);

  useEffect(() => {
    if (open) void navigate({ to: "/", replace: true });
  }, [open, navigate]);

  if (migration === undefined || !migration.planned) return null;
  return (
    <MigrationView
      migration={migration}
      signIn={signIn}
      onSignIn={run}
      onContinue={() => void navigate({ to: "/", replace: true })}
    />
  );
}
