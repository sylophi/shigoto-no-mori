// The unauthenticated landing page: starts the OAuth redirect, or
// explains that this build carries no account service configuration.
// Signed-in visitors are bounced straight to the devices page.
import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { CloudOff, LogIn } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { redirectTo, webPaths } from "./nav";

export function LoginPage() {
  const { data: status, isPending } = useAccountStatus();

  useEffect(() => {
    if (status?.signedIn === true) redirectTo(webPaths.devices);
  }, [status?.signedIn]);

  // The bridge's signIn navigates the whole page away on success, so
  // this mutation only ever settles when the redirect could not start.
  const signIn = useMutation({
    mutationFn: () => window.api.account.signIn(),
    meta: { silentError: true },
  });

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium tracking-tight">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Browse your devices&apos; forests from this browser. Read-only:
            nothing here can change a machine.
          </p>
        </div>

        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : status?.configured === false ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
            <CloudOff className="mt-0.5 size-4 shrink-0" />
            <span>
              This deployment is not configured for web access. The build is
              missing its account service settings, so sign-in is unavailable.
            </span>
          </div>
        ) : (
          <Button
            variant="secondary"
            disabled={signIn.isPending}
            onClick={() => signIn.mutate()}
          >
            <LogIn />
            {signIn.isPending ? "Redirecting…" : "Sign in with your account"}
          </Button>
        )}

        {signIn.isError && (
          <ErrorBanner>
            Couldn&apos;t start sign-in: {errorMessageOf(signIn.error)}
          </ErrorBanner>
        )}
      </div>
    </div>
  );
}
