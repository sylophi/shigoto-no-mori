// Doubutsu names, Prioritize birthdays and Village life, read off the
// config that holds each.
//
// doubutsuNames and prioritizeBirthdays are device settings
// (config.json, beside each other), read by the CLI's name pick.
// doubutsuNames reads as off when unset, which is what an install from
// before it defaulted on has, so an upgrade never changes its names. A
// fresh install is seeded with it on instead (host/lib/bootstrap.ts and
// cli/state.go seedFreshInstall). It picks worktree names from the
// Animal Crossing pool, in the CLI (cli/names.go doubutsuNamesEnabled,
// the same default), at create time and for the New Worktree form's
// pre-pick (`sm worktrees destination`). prioritizeBirthdays reads as
// off when unset and counts only while doubutsuNames is on: the pick
// then invites a villager whose birthday it is first
// (cli/birthdays.go prioritizeBirthdaysEnabled, the same rule).
//
// villageLife is a client setting (ClientConfig): the purely visual
// villager extras on every worktree named after a character, whichever
// device it lives on, with the villager data this device holds
// (host/lib/villagers.ts). Off when unset.
import type { ClientConfig, GlobalConfig } from "./schemas/config";
import type { VillagerDataStatus } from "./schemas/villagers";

type NamesConfig = Pick<GlobalConfig, "doubutsuNames" | "prioritizeBirthdays">;

export function doubutsuNamesEnabled(config: NamesConfig): boolean {
  return config.doubutsuNames ?? false;
}

export function prioritizeBirthdaysEnabled(config: NamesConfig): boolean {
  return doubutsuNamesEnabled(config) && (config.prioritizeBirthdays ?? false);
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
