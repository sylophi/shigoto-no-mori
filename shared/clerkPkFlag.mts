// The argv flag main uses to hand the resolved Clerk publishable key to
// the sandboxed preload (webPreferences.additionalArguments), so the
// renderer can decide synchronously whether to mount the ClerkProvider.
// Empty value means the build is unconfigured. Same pattern as
// deviceIdFlag.mts, and the same constraint: constant-only module, the
// preload bundle imports it.
export const CLERK_PK_FLAG = "--sm-clerk-publishable-key=";
