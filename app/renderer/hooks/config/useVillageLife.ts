import {
  villageLifeEnabled,
  villageLifeShows,
} from "@shigomori/ui/lib/villageLife.ts";
import { useVillagerDataStatus } from "@/hooks/villagers/useVillagerData";
import { useClientConfig } from "./useClientConfig";

// Whether villager extras show: true only while this window has Village
// life on (villageLifeEnabled in shared/villageLife.ts) and this device
// holds the villager data, downloaded from Settings. Every villager
// extra (faces, catchphrases, birthdays, anything purely visual that
// dresses up a worktree named after a character) MUST gate on this
// hook, so one switch in Settings turns them all off together.
// VillagerIcon and useVillagerProfiles already do.
//
// Client-scoped: the same answer for every device's worktrees this
// window shows. False until both have loaded, so an extra never flashes
// in while it is off, and always on a web client, which has no device
// of its own to hold the data.
export function useVillageLife(): boolean {
  const { data: config } = useClientConfig();
  const on = config !== undefined && villageLifeEnabled(config);
  const { data: status } = useVillagerDataStatus({ enabled: on });
  return config !== undefined && villageLifeShows(config, status);
}
