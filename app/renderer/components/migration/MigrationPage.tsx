import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useMigration } from "@/hooks/useMigration";
import { migrationShows } from "@shigomori/contracts/schemas/migration";
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
  const migration = useMigration();
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
  // Not before the account says whether the device key is due.
  const { data: account } = useAccountStatus();
  const { open } =
    migration == null || account === undefined
      ? { open: false }
      : migrationEnded(migration, signIn);
  // On to the app, for every window: the shell keeps the page until one
  // goes on past it.
  const goOn = () => {
    void window.api.migration.continue();
    void navigate({ to: "/", replace: true });
  };

  // A live session enrolls once, by itself.
  const { step, run } = enrollment;
  const enrolled = useRef(false);
  useEffect(() => {
    if (!keyDue || step !== "enroll" || enrolled.current) return;
    enrolled.current = true;
    run();
  }, [keyDue, step, run]);

  // Every step done, or nothing (left) to show.
  const nothing =
    migration === null ||
    (migration !== undefined &&
      migration.planned &&
      !migrationShows(migration));
  useEffect(() => {
    if (open) {
      void window.api.migration.continue();
      void navigate({ to: "/", replace: true });
    } else if (nothing) {
      void navigate({ to: "/", replace: true });
    }
  }, [open, nothing, navigate]);

  if (migration == null || !migrationShows(migration)) return null;
  return (
    <MigrationView
      migration={migration}
      signIn={signIn}
      onSignIn={run}
      onContinue={goOn}
    />
  );
}
