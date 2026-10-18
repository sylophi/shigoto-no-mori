// Doubutsu names and Village life, read off the config that holds each.
//
// doubutsuNames is a device setting, read by the engine's name pick.
// It reads as off when unset, which is what an install from
// before it defaulted on has, so an upgrade never changes its names. A
// fresh install is seeded with it on instead (the store's first open,
// the engine's migrations/importJson.ts). It picks worktree names from
// the Animal Crossing pool, in the engine (names.ts, the same default), at create time and for the New Worktree form's
// pre-pick (`sm worktrees destination`).
//
// villageLife is a client setting (ClientConfig): the purely visual
// villager extras on every worktree named after a character, whichever
// device it lives on, with the villager data this device holds
// (host/lib/VillagerData.ts).
import {
  type ClientConfig,
  clientSetting,
  DEVICE_SETTINGS_DEFAULTS,
  type GlobalConfig,
} from "@shigomori/contracts/schemas/config";
import type { VillagerDataStatus } from "@shigomori/contracts/schemas/villagers";

export function doubutsuNamesEnabled(
  config: Pick<GlobalConfig, "doubutsuNames">,
): boolean {
  return config.doubutsuNames ?? DEVICE_SETTINGS_DEFAULTS.doubutsuNames;
}

type VillageConfig = Pick<ClientConfig, "villageLife">;

// The one switch for villager extras. The renderer reads it through
// useVillageLife (renderer/hooks/config/useVillageLife.ts).
export function villageLifeEnabled(config: VillageConfig): boolean {
  return clientSetting(config, "villageLife");
}

// Whether the extras show: the switch on and the villager data all
// downloaded. The hook and the toasts fired outside render
// (renderer/lib/villagers/speakers.ts) both ask this.
export function villageLifeShows(
  config: VillageConfig,
  status: Pick<VillagerDataStatus, "kind"> | undefined,
): boolean {
  return villageLifeEnabled(config) && status?.kind === "ready";
}
