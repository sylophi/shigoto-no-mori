// The scoped device's side of the worktree layout math
// (@shigomori/contracts/git/worktreeLayout): where its data dir is, its
// home, which a custom `~/` base sits under and the callers tildify
// against, and whether its managedOnProjectDrive setting keeps managed
// worktrees on the project's drive. Null until both the runtime paths
// and the settings are read.
import { DEVICE_SETTINGS_DEFAULTS } from "@shigomori/contracts/schemas";
import type { DeviceLayout } from "@shigomori/contracts/git/worktreeLayout";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

export function useDeviceLayout(): DeviceLayout | null {
  const { data: runtime } = useRuntimeInfo();
  // Silent like the runtime read beside it: a peer that refuses reads
  // gets no path spelled, not a toast per label.
  const { data: globalConfig } = useGlobalConfig();
  if (!runtime || !globalConfig) return null;
  return {
    dataDir: runtime.dataDir,
    dataDirReal: runtime.dataDirReal,
    canonicalDataDirName: runtime.canonicalDataDirName,
    homedir: runtime.homedir,
    onProjectDrive:
      globalConfig.managedOnProjectDrive ??
      DEVICE_SETTINGS_DEFAULTS.managedOnProjectDrive,
  };
}
