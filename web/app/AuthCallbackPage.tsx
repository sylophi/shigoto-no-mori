// The OAuth redirect target. Completes the parked flow exactly once on
// mount (exchange, enroll, store), then moves on to the devices page.
// Failure renders the reason with a way back to the login page rather
// than a dead end, since an abandoned or replayed callback URL is a
// normal occurrence.
import { useEffect, useRef, useState } from "react";
import { errorMessageOf } from "@shared/errors";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { webBridge } from "../bridge/install";
import { navigateTo, redirectTo, webPaths } from "./nav";

export function AuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  // React 18+ strict/dev double-mount must not run the exchange twice:
  // the second run would find the pending record consumed and surface a
  // bogus "no sign-in in progress" over a successful first run.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    webBridge()
      .completeLoginRedirect(window.location.href)
      // Replace, not push: the callback URL still carries the spent
      // authorization code, and Back must not resurface it.
      .then(() => redirectTo(webPaths.devices))
      .catch((cause: unknown) => setError(errorMessageOf(cause)));
  }, []);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-medium tracking-tight">
          Completing sign-in
        </h1>
        {error === null ? (
          <p className="text-sm text-muted-foreground">
            Finishing the sign-in and enrolling this browser…
          </p>
        ) : (
          <>
            <ErrorBanner>Sign-in failed: {error}</ErrorBanner>
            <Button
              variant="outline"
              onClick={() => navigateTo(webPaths.login)}
            >
              Back to sign-in
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
