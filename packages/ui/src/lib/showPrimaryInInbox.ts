import {
  PROJECT_CONFIG_DEFAULTS,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas/index";

// A project's primary opt-in off its config query's data: undefined
// while the config is unread, and false for a project with no config.
export function showPrimaryInInbox(
  config: ShigomoriConfig | null | undefined,
): boolean | undefined {
  return config === undefined
    ? undefined
    : (config?.showPrimaryInInbox ??
        PROJECT_CONFIG_DEFAULTS.showPrimaryInInbox);
}
