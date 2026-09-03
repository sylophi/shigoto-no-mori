// "/devices" on the web: the SAME page as the desktop's, the account
// line over the device registry (renderer/components/remote), rendered
// through the same hooks, so the two clients cannot drift. The rows
// already know they are on the web shell (window.api.isElectron) and
// drop what a browser cannot do: expose itself to peers, host
// projects, bind a forward. What the web adds is only what the web
// can get wrong that the desktop cannot: the deployment access banner
// (the device hub refusing this origin) and honest reachability
// messages when the device list will not load.
import { useEffect, useSyncExternalStore } from "react";
import { errorMessageOf } from "@shared/errors";
import type { AccountStatus } from "@shared/ipc/modules/account";
import { ErrorBanner } from "@/components/ui/error-banner";
import { DeviceRegistry } from "@/components/remote/DeviceRegistry";
import { PageShell } from "@/components/shared/PageShell";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { isFetchFailure, isHubRefusedError } from "../account/webAccess";
import { webBridge } from "../bridge/install";
import { redirectTo, webPaths } from "./nav";

function useWebAccess() {
  const store = webBridge().webAccess;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function DevicesPage() {
  const { data: status, isPending: statusPending } = useAccountStatus();
  const signedIn = status?.signedIn === true;

  useEffect(() => {
    if (!statusPending && !signedIn) redirectTo(webPaths.login);
  }, [statusPending, signedIn]);

  return (
    <PageShell
      page="devices"
      eyebrow="Shigoto no Mori"
      title="Devices"
      watermark="機器"
    >
      {statusPending || !signedIn ? (
        <p className="text-xs text-muted-foreground/70">Loading&hellip;</p>
      ) : (
        <DevicesBody status={status} />
      )}
    </PageShell>
  );
}

// The signed-in page body, split out so its hooks only run once the
// status guard above has passed and the page shell stays a flat
// two-branch render.
function DevicesBody({ status }: { status: AccountStatus }) {
  const webAccess = useWebAccess();

  return (
    <>
      {webAccess.kind === "blocked" && (
        <ErrorBanner>
          The device hub refused this request ({webAccess.message}). This
          deployment cannot serve the device list until the device hub accepts
          it.
        </ErrorBanner>
      )}
      <DeviceRegistry
        accountId={status.accountId}
        describeError={reachabilityMessage}
      />
    </>
  );
}

// One honest sentence per failure shape. A browser cannot tell a
// refusing device hub from an unreachable one when the response carries
// no CORS headers, so the fetch-failure branch names both possibilities
// instead of guessing.
function reachabilityMessage(error: unknown): string {
  if (isHubRefusedError(error)) {
    return "The device hub refused this request, so the device list is unavailable.";
  }
  if (isFetchFailure(error)) {
    return (
      "Couldn't reach the device hub. Either you are offline, or this " +
      "deployment's hub URL does not point at a reachable Worker."
    );
  }
  return `Couldn't load the device list: ${errorMessageOf(error)}`;
}
