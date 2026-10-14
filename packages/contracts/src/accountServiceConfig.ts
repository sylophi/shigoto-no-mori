// Public endpoints and a publishable key, never a secret: safe to log
// and to ship empty.

export type AccountServiceConfig = {
  hubUrl: string;
  // Of the Clerk application whose secret key the hub verifies tokens
  // with.
  publishableKey: string;
  // The one origin the device link's Origin gate admits browser dials
  // from. Not part of isConfigured.
  webOrigin: string;
};

// Both build bakes derive from this, so a field can't be renamed on one
// side and silently drop out of a shipped build.
export const ACCOUNT_ENV = {
  hubUrl: "SM_DEVICE_HUB_URL",
  publishableKey: "SM_ACCOUNT_CLERK_PUBLISHABLE_KEY",
  webOrigin: "SM_ACCOUNT_WEB_ORIGIN",
} as const satisfies Record<keyof AccountServiceConfig, string>;
export const ACCOUNT_ENV_KEYS = Object.values(ACCOUNT_ENV);

export function resolveServiceConfig(
  env: Record<string, string | undefined>,
): AccountServiceConfig {
  return {
    hubUrl: (env[ACCOUNT_ENV.hubUrl] ?? "").trim(),
    publishableKey: (env[ACCOUNT_ENV.publishableKey] ?? "").trim(),
    webOrigin: (env[ACCOUNT_ENV.webOrigin] ?? "").trim(),
  };
}

export function isConfigured(config: AccountServiceConfig): boolean {
  return config.hubUrl.length > 0 && config.publishableKey.length > 0;
}

// Lowest to highest: dev .env.local, the bundle's baked values, the
// real environment.
export function mergeServiceEnv(
  fileEnv: Record<string, string | undefined>,
  bakedEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...fileEnv, ...bakedEnv, ...processEnv };
}
