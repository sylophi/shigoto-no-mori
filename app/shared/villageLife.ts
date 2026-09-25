// Doubutsu names and Village life, read off a device's config.
//
// Both are device settings (config.json, beside each other).
// doubutsuNames reads as off when unset, which is what an install from
// before it defaulted on has, so an upgrade never changes its names. A
// fresh install is seeded with it on instead (host/lib/bootstrap.ts and
// cli/state.go seedFreshInstall). It picks worktree names from the
// Animal Crossing pool, in the CLI (cli/names.go doubutsuNamesEnabled,
// the same default), at create time and for the New Worktree form's
// pre-pick (`sm worktrees destination`). villageLife reads as off when
// unset, and a
// fresh install does not seed it. It is the app's alone: it gates the
// purely visual villager extras on those worktrees, and it counts only
// while doubutsuNames is on, since without villager names there are no
// villagers to bring along.
import type { GlobalConfig } from "./schemas/config";

type VillageConfig = Pick<GlobalConfig, "doubutsuNames" | "villageLife">;

export function doubutsuNamesEnabled(config: VillageConfig): boolean {
  return config.doubutsuNames ?? false;
}

// The one gate for villager extras. The renderer reads it through
// useVillageLife (renderer/hooks/config/useVillageLife.ts).
export function villageLifeEnabled(config: VillageConfig): boolean {
  return doubutsuNamesEnabled(config) && (config.villageLife ?? false);
}
