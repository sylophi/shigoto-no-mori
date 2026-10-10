// Getting this device enrolled, the one place it is decided: where the
// Clerk session lives that is one call (account:enroll under a fresh
// token), and where it lapsed a sign-in first, which ClerkAccountSync
// turns into the enrollment.
//
// The sign-in button runs it, and so does the move to v3's device key
// step: a device enrolled before device keys reads as signed out until
// it enrolls again, which makes its key pair and registers the public
// half (shared/account/enroll.ts). `needsDeviceKey` says that step is
// due; the migration screen reads `step` and calls `run`, and adds no
// enrollment of its own. Mount it under the ClerkProvider (ClerkGate),
// like every Clerk hook.
//
// The sign-in is one click where it can be: an instance whose only way
// in is one social provider (GitHub, today) starts its OAuth at once,
// through the Electron bridge on the desktop and by redirect in the web
// client, which finishes the sign-in on the way back
// (useFinishRedirectSignIn). Clerk's modal opens only when there is a
// choice to make.
import { useAuth, useClerk } from "@clerk/react";
import { useIsMutating } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  ENROLL_MUTATION_KEY,
  useAccountStatus,
  useEnroll,
} from "@/hooks/account/useAccount";
import { hasLocalHost } from "@/lib/localHost";
import { toast } from "@/lib/toast";
import { errorMessageOf } from "@shigomori/contracts/errors";

export type EnrollmentStep =
  // Enrolled, with a key.
  | "done"
  // An enrollment is running, here or in ClerkAccountSync.
  | "enrolling"
  // The session lives: `run` enrolls now.
  | "enroll"
  // The session lapsed: `run` opens the sign-in, and the enrollment
  // follows it.
  | "sign-in";

type Clerk = ReturnType<typeof useClerk>;
type OAuthStrategy = Parameters<
  NonNullable<Clerk["client"]>["signIn"]["authenticateWithRedirect"]
>[0]["strategy"];

// The marker on the web client's return from a provider, which tells
// the page to finish the sign-in.
const REDIRECT_RETURN_PARAM = "sm-sign-in";

// What Clerk knows of the instance's sign-in settings, the part read
// here. Clerk exposes it only through an internal getter.
const ENVIRONMENT = "__internal_environment";
type UserSettings = {
  readonly authenticatableSocialStrategies?: OAuthStrategy[];
  readonly enabledFirstFactorIdentifiers?: unknown[];
  readonly web3FirstFactors?: unknown[];
  readonly attributes?: { readonly passkey?: { readonly enabled?: boolean } };
  readonly enterpriseSSO?: { readonly enabled?: boolean };
};

// The provider to start at once when it is the instance's only way in,
// else null.
function onlyProvider(clerk: Clerk): OAuthStrategy | null {
  const environment = Reflect.get(clerk, ENVIRONMENT) as
    | { readonly userSettings?: UserSettings }
    | undefined;
  const settings = environment?.userSettings;
  const social = settings?.authenticatableSocialStrategies ?? [];
  const [only] = social;
  return social.length === 1 &&
    only !== undefined &&
    (settings?.enabledFirstFactorIdentifiers ?? []).length === 0 &&
    (settings?.web3FirstFactors ?? []).length === 0 &&
    settings?.attributes?.passkey?.enabled !== true &&
    settings?.enterpriseSSO?.enabled !== true
    ? only
    : null;
}

function startSignIn(clerk: Clerk): void {
  const strategy = onlyProvider(clerk);
  const signIn = clerk.client?.signIn;
  if (strategy === null || signIn === undefined) {
    clerk.openSignIn(
      hasLocalHost ? undefined : { forceRedirectUrl: location.href },
    );
    return;
  }
  // On the desktop the bridge's transport takes both URLs over and
  // finishes in place; in a browser the provider sends the page back
  // here, marked.
  const back = new URL(location.href);
  back.searchParams.set(REDIRECT_RETURN_PARAM, "1");
  signIn
    .authenticateWithRedirect({
      strategy,
      redirectUrl: back.href,
      redirectUrlComplete: location.href,
    })
    .catch((error: unknown) => {
      toast.error("Couldn't start the sign-in", {
        description: errorMessageOf(error),
      });
    });
}

// Finishes a web client's sign-in on its return from the provider, and
// takes the marker off the address. Mounted once, by ClerkAccountSync.
export function useFinishRedirectSignIn(): void {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  useEffect(() => {
    if (hasLocalHost || !isLoaded) return;
    const here = new URL(location.href);
    if (!here.searchParams.has(REDIRECT_RETURN_PARAM)) return;
    here.searchParams.delete(REDIRECT_RETURN_PARAM);
    history.replaceState(history.state, "", here.href);
    clerk
      .handleRedirectCallback({
        signInFallbackRedirectUrl: here.href,
        signUpFallbackRedirectUrl: here.href,
      })
      .catch((error: unknown) => {
        toast.error("Couldn't finish the sign-in", {
          description: errorMessageOf(error),
        });
      });
  }, [clerk, isLoaded]);
}

export function useEnrollment(): {
  step: EnrollmentStep;
  needsDeviceKey: boolean;
  // The last enrollment's failure here, cleared by the next run.
  error: Error | null;
  run: () => void;
} {
  const { data: status } = useAccountStatus();
  const { isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const enroll = useEnroll();
  const enrolling = useIsMutating({ mutationKey: ENROLL_MUTATION_KEY }) > 0;
  const step: EnrollmentStep =
    status?.signedIn === true
      ? "done"
      : enrolling
        ? "enrolling"
        : isSignedIn
          ? "enroll"
          : "sign-in";
  return {
    step,
    needsDeviceKey: status?.needsDeviceKey === true,
    error: enroll.error,
    run: () => {
      if (step === "enroll") {
        enroll.mutate(() => getToken({ skipCache: true }));
      } else if (step === "sign-in") {
        startSignIn(clerk);
      }
    },
  };
}
