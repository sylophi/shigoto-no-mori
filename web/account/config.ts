// The web build's account service configuration. The desktop reads the
// SM_ACCOUNT_* variables from the process environment at launch; a
// static web build has no process, so the same variables are baked in
// at build time through Vite's import.meta.env (vite.web.config.ts adds
// "SM_ACCOUNT_" to envPrefix). Everything here is a public endpoint or
// a public OAuth client_id, never a secret (see serviceConfig.ts), so
// inlining the values into the shipped bundle is safe by design.
import {
  isConfigured,
  resolveServiceConfig,
  type AccountServiceConfig,
} from "@shared/account/serviceConfig";

export type { AccountServiceConfig };
export { isConfigured };

// import.meta.env exists in every Vite context but not under plain node,
// where the headless bridge check imports this module and injects its
// own env instead. The structural cast keeps the node path honest
// without weakening the Vite typing at call sites.
export function viteEnv(): Record<string, string | undefined> {
  const meta = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };
  return meta.env ?? {};
}

export function webServiceConfig(
  env: Record<string, string | undefined>,
): AccountServiceConfig {
  return resolveServiceConfig(env);
}
