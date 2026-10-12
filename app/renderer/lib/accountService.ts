import { useApi } from "@/lib/runtime/pageApi";

// Whether this build carries an account service (a Clerk publishable
// key). Without one ClerkGate mounts no ClerkProvider, so nothing may
// call a Clerk hook, and the account reads as unconfigured: sign-in
// stays off (lab/dev-app.md). A constant for the page's life, off the
// page's api.
export function useHasAccountService(): boolean {
  return Boolean(useApi().clerkPublishableKey);
}
