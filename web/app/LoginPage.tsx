// The unauthenticated landing page: Clerk's embedded sign-in, or an
// explanation that this build carries no account service configuration.
// Signed-in (enrolled) visitors are bounced straight to the devices
// page; ClerkAccountSync performs the enrollment the moment Clerk
// reports a session, so completing the form below lands on /devices
// without a callback route.
import { useEffect } from "react";
import { SignIn } from "@clerk/react";
import { CloudOff } from "lucide-react";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { redirectTo, webPaths } from "./nav";

export function LoginPage() {
  const { data: status, isPending } = useAccountStatus();

  useEffect(() => {
    if (status?.signedIn === true) redirectTo(webPaths.devices);
  }, [status?.signedIn]);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      {status?.configured === true ? (
        // Rendering the Clerk component is gated on configured, which
        // implies the ClerkProvider is mounted (ClerkGate): a pending
        // or errored status must not fall through to a bare <SignIn />.
        <SignIn />
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex w-full max-w-sm items-start gap-2 rounded-lg border border-dashed border-border bg-card px-3 py-3 text-sm text-muted-foreground shadow-sm">
          <CloudOff className="mt-0.5 size-4 shrink-0" />
          <span>
            This deployment is not configured for web access. The build is
            missing its account service settings, so sign-in is unavailable.
          </span>
        </div>
      )}
    </div>
  );
}
