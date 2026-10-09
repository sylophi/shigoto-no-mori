// Doubutsu names and Village life, read off the config that holds each.
//
// doubutsuNames is a device setting (config.json), read by the CLI's
// name pick. It reads as off when unset, which is what an install from
// before it defaulted on has, so an upgrade never changes its names. A
// fresh install is seeded with it on instead (the store's first open,
// the engine's migrations/importJson.ts). It picks worktree names from
// the Animal Crossing pool, in the engine (names.ts, the same default), at create time and for the New Worktree form's
// pre-pick (`sm worktrees destination`).
//
// villageLife is a client setting (ClientConfig): the purely visual
// villager extras on every worktree named after a character, whichever
// device it lives on, with the villager data this device holds
// (host/lib/villagers.ts). Off when unset.
import type {
  ClientConfig,
  GlobalConfig,
} from "@shigomori/contracts/schemas/config";
import type { VillagerDataStatus } from "@shigomori/contracts/schemas/villagers";

export function doubutsuNamesEnabled(
  config: Pick<GlobalConfig, "doubutsuNames">,
): boolean {
  return config.doubutsuNames ?? false;
}

type VillageConfig = Pick<ClientConfig, "villageLife">;

// The one switch for villager extras. The renderer reads it through
// useVillageLife (renderer/hooks/config/useVillageLife.ts).
export function villageLifeEnabled(config: VillageConfig): boolean {
  return config.villageLife ?? false;
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

// Whether villagers moving in or out say so (Village news, under
// Village life). On when unset.
export function villageNewsEnabled(
  config: Pick<ClientConfig, "villageNews">,
): boolean {
  return config.villageNews ?? true;
}
