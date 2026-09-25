import { villageLifeEnabled } from "@shared/villageLife";
import { useGlobalConfig } from "./useGlobalConfig";

// Whether villager extras show: true only while the device has both
// Doubutsu names and Village life on (villageLifeEnabled in
// shared/villageLife.ts). Every villager extra (faces, catchphrases,
// birthdays, anything purely visual that dresses up a doubutsu-named
// worktree) MUST gate on this hook, and only on it, so one switch in
// Settings turns them all off together.
//
// Host-scoped like useGlobalConfig: under a peer's HostScope it answers
// with that peer's settings, since the device that named a worktree
// after a villager decides whether the villager comes with extras.
// False until the config has loaded (and always on a hostless client's
// local scope, which has no config), so an extra never flashes in for
// a device that has it off.
export function useVillageLife(): boolean {
  const { data: config } = useGlobalConfig();
  return config !== undefined && villageLifeEnabled(config);
}
