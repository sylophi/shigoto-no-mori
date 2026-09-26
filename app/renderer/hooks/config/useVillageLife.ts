import { villageLifeEnabled, villageLifeShows } from "@shared/villageLife";
import { useVillagerDataStatus } from "@/hooks/villagers/useVillagerData";
import { useGlobalConfig } from "./useGlobalConfig";

// Whether villager extras show: true only while the device has both
// Doubutsu names and Village life on (villageLifeEnabled in
// shared/villageLife.ts) and holds the villager data, downloaded from
// Settings. Every villager extra (faces, catchphrases, birthdays,
// anything purely visual that dresses up a doubutsu-named worktree)
// MUST gate on this hook, so one switch in Settings turns them all off
// together. VillagerIcon and useVillagerProfiles already do.
//
// Host-scoped like useGlobalConfig: under a peer's HostScope it answers
// with that peer's settings and data, since the device that named a
// worktree after a villager decides whether the villager comes with
// extras. False until both have loaded (and always on a hostless
// client's local scope, which has neither), so an extra never flashes
// in for a device that has it off.
export function useVillageLife(): boolean {
  const { data: config } = useGlobalConfig();
  const on = config !== undefined && villageLifeEnabled(config);
  const { data: status } = useVillagerDataStatus({ enabled: on });
  return config !== undefined && villageLifeShows(config, status);
}
