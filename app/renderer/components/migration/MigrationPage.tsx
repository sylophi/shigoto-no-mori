import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { callOf } from "@shigomori/contracts/contract";
import { migrationContract } from "@shigomori/contracts/modules/migration";
import { MigrationView } from "@shigomori/ui/views/steps/MigrationView.tsx";
import { migrationEnded } from "@shigomori/ui/views/steps/migrationEnded.ts";
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
// (the /migration route). With every step done it opens the app by
// itself, and with nothing to migrate at once.
export function MigrationPage() {
  const { data: migration } = useView(hasLocalHost ? migrationAtom : null);
  const navigate = useNavigate();
  const { ended, stuck } =
    migration === undefined
      ? { ended: false, stuck: false }
      : migrationEnded(migration);
  const openApp = () => void navigate({ to: "/", replace: true });

  useEffect(() => {
    if (ended && !stuck) void navigate({ to: "/", replace: true });
  }, [ended, stuck, navigate]);

  if (migration === undefined || !migration.planned) return null;
  return (
    <MigrationView
      migration={migration}
      signingIn={false}
      onSignIn={() => void navigate({ to: "/account" })}
      onContinue={openApp}
    />
  );
}
