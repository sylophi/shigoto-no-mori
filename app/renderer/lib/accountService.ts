// Whether this build carries an account service (a Clerk publishable
// key). Without one ClerkGate mounts no ClerkProvider, so nothing may
// call a Clerk hook, and the account reads as unconfigured: sign-in
// stays off (lab/dev-app.md). Read once off the bridge like
// hasLocalHost, a constant for the window's life.
export const hasAccountService = Boolean(window.api.clerkPublishableKey);
