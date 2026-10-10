// Non-secret service configuration for the hub account layer, read
// from the environment at launch. Everything here is a public endpoint
// or a public Clerk publishable key, never a secret, so it is safe to
// log and safe to ship empty. Empty required fields mean "the owner has
// not configured this build yet" and isConfigured returns false. This
// module is pure (no electron, no node builtins) so the account check
// script can drive it without a running app.

// The env vars an owner sets after deploying the hub Worker and
// creating a Clerk application. All non-secret.
export type AccountServiceConfig = {
  // Base URL of the hub Worker, e.g. https://hub.example.com. The
  // account service joins HUB_ROUTES paths onto this.
  hubUrl: string;
  // The Clerk publishable key (pk_test_... / pk_live_...) of the same
  // Clerk application whose secret key the hub Worker verifies
  // session tokens with. Publishable by definition: it only names the
  // instance's Frontend API host.
  publishableKey: string;
  // Exact origin of the deployed web client.
  // Desktop-only: the device hub serves any origin, this gate does not.
  // The device link's Origin gate admits browser dials from
  // exactly this origin, so a web client can dial wss tunnel URLs.
  // Empty means no web origin is admitted. Not part of isConfigured:
  // the account layer works without it.

  webOrigin: string;
};

// Each config field and the env var it reads, in one place: the
// resolver below and both build bakes (vite.node.config.ts defines
// exactly these keys, vite.web.config.ts passes them to envPrefix)
// derive from it, so a field cannot be renamed on one side only and
// silently drop out of a shipped build.
export const ACCOUNT_ENV = {
  hubUrl: "SM_DEVICE_HUB_URL",
  publishableKey: "SM_ACCOUNT_CLERK_PUBLISHABLE_KEY",
  webOrigin: "SM_ACCOUNT_WEB_ORIGIN",
} as const satisfies Record<keyof AccountServiceConfig, string>;
export const ACCOUNT_ENV_KEYS = Object.values(ACCOUNT_ENV);

// Reads the config from a plain env-like record so tests can pass a
// literal instead of mutating process.env. A missing var reads as the
// empty string, which flows through to isConfigured as "not set".
export function resolveServiceConfig(
  env: Record<string, string | undefined>,
): AccountServiceConfig {
  return {
    hubUrl: (env[ACCOUNT_ENV.hubUrl] ?? "").trim(),
    publishableKey: (env[ACCOUNT_ENV.publishableKey] ?? "").trim(),
    webOrigin: (env[ACCOUNT_ENV.webOrigin] ?? "").trim(),
  };
}

// True only when every field the account layer needs is present. The
// renderer disables Sign in until this is true.
export function isConfigured(config: AccountServiceConfig): boolean {
  return config.hubUrl.length > 0 && config.publishableKey.length > 0;
}

// Merges the three config layers, lowest to highest precedence: the
// optional dev .env.local values, the values baked into the bundle at
// build time, and the real process environment. Real environment
// variables always win, so an owner can override even a baked build
// from the environment, and a build with nothing baked in reads the
// environment alone.
export function mergeServiceEnv(
  fileEnv: Record<string, string | undefined>,
  bakedEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...fileEnv, ...bakedEnv, ...processEnv };
}
