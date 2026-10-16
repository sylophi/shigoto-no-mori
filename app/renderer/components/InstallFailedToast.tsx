import { useEffect } from "react";
import { useInstallFailure } from "@/hooks/system/useUpdater";
import { notifyError } from "@/lib/toast";

// Says why this machine's last "Restart to update" came back without
// the update, or didn't come back on its own: the installer's reason,
// which only the next start of the app can show.
export function InstallFailedToast() {
  const failure = useInstallFailure();
  useEffect(() => {
    if (failure !== null) notifyError("The update didn't finish", failure);
  }, [failure]);
  return null;
}
