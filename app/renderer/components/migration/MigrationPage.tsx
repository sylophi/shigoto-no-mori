import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { useMigration } from "@/hooks/useMigration";
import { migrationOwed } from "@shigomori/contracts/schemas/migration";
import { MigrationView } from "@shigomori/ui/views/steps/MigrationView.tsx";
import { migrationEnded } from "@shigomori/ui/views/steps/migrationEnded.ts";
import { useSignInStep } from "@/components/steps/useSignInStep";
import { useApi } from "@/lib/runtime/pageApi";
import { notifyError } from "@/lib/toast";

// The v3 migration as this machine's shell serves it, in place of the app
// (the /migration route), with this device's enrollment for its key
// (useEnrollment) as its sign-in: by itself while the session lives, a
// button once it has lapsed. With every step done it opens the app, and
// with nothing to migrate at once.
export function MigrationPage() {
  const api = useApi();
  const migration = useMigration();
  // Shown from the moment the device key is due, and done once it no
  // longer is.
  const [keyDue, setKeyDue] = useState(false);
  const step = useSignInStep(keyDue);
  if (step.needsDeviceKey && !keyDue) setKeyDue(true);
  const signIn = keyDue ? step.signIn : null;
  const navigate = useNavigate();
  // The stuck moves tried again: pending while the host tries them, and
  // remembered once one has run, so a move still stuck says so. A retry
  // that failed says that instead.
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState(false);
  const retry = () => {
    setRetrying(true);
    void api
      .run(api.migration.retry())
      .then(
        () => setRetried(true),
        (error: unknown) => notifyError("Couldn't retry the move", error),
      )
      .finally(() => setRetrying(false));
  };
  // Not before the account says whether the device key is due.
  const { data: account } = useAccountStatus();
  const { open } =
    migration == null || account === undefined
      ? { open: false }
      : migrationEnded(migration, signIn);
  // On to the app, for every window: the shell keeps the page until one
  // goes on past it.
  const goOn = () => {
    void api.run(api.migration.continue());
    void navigate({ to: "/", replace: true });
  };

  // Every step done, or nothing (left) to show.
  const nothing =
    migration === null ||
    (migration !== undefined && migration.planned && !migrationOwed(migration));
  useEffect(() => {
    if (open) {
      void api.run(api.migration.continue());
      void navigate({ to: "/", replace: true });
    } else if (nothing) {
      void navigate({ to: "/", replace: true });
    }
  }, [open, nothing, navigate, api]);

  // Nothing drawn on the way out, so a migration that finished clean
  // never flashes the page.
  if (migration == null || !migrationOwed(migration) || open) return null;
  return (
    <MigrationView
      migration={migration}
      signIn={signIn}
      onSignIn={step.run}
      onContinue={goOn}
      onRetry={retry}
      retrying={retrying}
      retried={retried}
    />
  );
}
