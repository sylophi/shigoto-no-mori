// The web build's account service configuration. The desktop reads the
// account service variables (ACCOUNT_ENV_KEYS) from the process
// environment at launch; a static web build has no process, so the same
// variables are baked in at build time through Vite's import.meta.env
// (vite.web.config.ts lists their prefixes in envPrefix). Everything
// here is a public endpoint or a public Clerk publishable key, never a
// secret (serviceConfig.ts), so inlining the values into the shipped
// bundle is safe by design.
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
  // Read as a single `import.meta.env` member expression, NOT via an
  // intermediate `const meta = import.meta`: Vite substitutes the env
  // only for that exact pattern. Binding import.meta to a variable
  // first defeats the substitution and leaves this returning {} in a
  // real build, which reads downstream as "the owner never configured
  // this deployment" and makes web sign-in permanently unreachable.
  return (
    (
      import.meta as ImportMeta & {
        env?: Record<string, string | undefined>;
      }
    ).env ?? {}
  );
}

export function webServiceConfig(
  env: Record<string, string | undefined>,
): AccountServiceConfig {
  return resolveServiceConfig(env);
}
