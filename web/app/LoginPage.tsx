// The unauthenticated landing page: Clerk's embedded sign-in under a
// short app-voiced introduction, or an explanation that this build
// carries no account service configuration. Signed-in (enrolled)
// visitors are bounced straight to the devices page, and
// ClerkAccountSync performs the enrollment the moment Clerk reports a
// session.
import { useEffect } from "react";
import { SignIn, useAuth } from "@clerk/react";
import { CloudOff, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccountStatus, useEnroll } from "@/hooks/account/useAccount";
import { redirectTo, webPaths } from "./nav";

export function LoginPage() {
  const { data: status, isPending } = useAccountStatus();

  useEffect(() => {
    if (status?.signedIn === true) redirectTo(webPaths.devices);
  }, [status?.signedIn]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto p-6">
      <div className="flex max-w-sm flex-col items-center gap-1 text-center">
        <span className="text-xs text-muted-foreground">Shigoto no Mori</span>
        <h1 className="text-lg font-medium tracking-tight">
          Your forests, from anywhere
        </h1>
        <p className="text-sm text-muted-foreground">
          Sign in to reach this account&apos;s devices through the device hub.
          This browser enrolls as a device of its own.
        </p>
      </div>
      {status?.configured === true ? (
        // The Clerk half is gated on configured, which implies the
        // ClerkProvider is mounted (ClerkGate): a pending or errored
        // status must not fall through to a bare Clerk hook.
        <ConfiguredLogin />
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">Loading&hellip;</p>
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

// With a live Clerk session this page means "enrollment has not landed
// yet" (ClerkAccountSync's automatic attempt is in flight, or it
// failed): rendering <SignIn/> to an already-signed-in visitor is a
// dead end, so show the completing state with a manual retry instead.
// The redirect props keep Clerk's post-sign-in navigation on this
// route, and the effect above forwards to /devices once enrolled.
function ConfiguredLogin() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const enroll = useEnroll();

  if (!isLoaded) {
    return <p className="text-sm text-muted-foreground">Loading&hellip;</p>;
  }
  if (isSignedIn) {
    return (
      <div className="flex w-full max-w-sm flex-col items-start gap-3 rounded-lg border border-border bg-card px-4 py-4 shadow-sm">
        <p className="text-sm text-muted-foreground">
          Signed in. Enrolling this browser with the device hub&hellip;
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={enroll.isPending}
          onClick={() => enroll.mutate(() => getToken({ skipCache: true }))}
        >
          <RotateCw />
          {enroll.isPending ? "Enrolling…" : "Retry enrollment"}
        </Button>
      </div>
    );
  }
  return (
    <SignIn
      forceRedirectUrl={webPaths.login}
      signUpForceRedirectUrl={webPaths.login}
    />
  );
}
