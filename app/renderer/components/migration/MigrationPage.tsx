import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { callOf } from "@shigomori/contracts/contract";
import { migrationContract } from "@shigomori/contracts/modules/migration";
import { MigrationView } from "@shigomori/ui/views/steps/MigrationView.tsx";
import { migrationEnded } from "@shigomori/ui/views/steps/migrationEnded.ts";
import { useSignInStep } from "@/components/steps/useSignInStep";
import { useMarkWelcomed } from "@/hooks/config/useWelcomed";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useView } from "@/lib/runtime/viewHooks";

const migrationAtom = hostViewAtom({
  deviceId: localDeviceId,
  localDeviceId,
  view: callOf(migrationContract, "watch"),
  input: undefined,
});

// The v3 migration as this machine's host runs it, in place of the app
// (the /migration route), with this device's enrollment for its key
// (useEnrollment) as its sign-in: by itself while the session lives, a
// button once it has lapsed. With every step done it opens the app, and
// with nothing to migrate at once.
export function MigrationPage() {
  const { data: migration } = useView(hasLocalHost ? migrationAtom : null);
  // Shown from the moment the device key is due, and done once it no
  // longer is.
  const [keyDue, setKeyDue] = useState(false);
  const { signIn, needsDeviceKey, run } = useSignInStep(keyDue);
  if (needsDeviceKey && !keyDue) setKeyDue(true);
  const shownSignIn = keyDue ? signIn : null;
  const navigate = useNavigate();
  const { open } =
    migration === undefined
      ? { open: false }
      : migrationEnded(migration, shownSignIn);

  // A device that migrates from v2 is past its first run.
  const migrated =
    migration !== undefined &&
    (migration.import !== null || migration.worktrees !== null);
  const markWelcomed = useMarkWelcomed();
  useEffect(() => {
    if (migrated) markWelcomed();
  }, [migrated, markWelcomed]);

  useEffect(() => {
    if (open) void navigate({ to: "/", replace: true });
  }, [open, navigate]);

  if (migration === undefined || !migration.planned) return null;
  return (
    <MigrationView
      migration={migration}
      signIn={shownSignIn}
      onSignIn={run}
      onContinue={() => void navigate({ to: "/", replace: true })}
    />
  );
}
