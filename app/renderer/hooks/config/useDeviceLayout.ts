// The scoped device's side of the worktree layout math
// (@shigomori/contracts/git/worktreeLayout): where its data dir is, and whether
// its managedOnProjectDrive setting keeps managed worktrees on the
// project's drive. With its home, for the paths the callers tildify.
// Null until both the runtime paths and the settings are read.
import { DEVICE_SETTINGS_DEFAULTS } from "@shigomori/contracts/schemas";
import type { DeviceLayout } from "@shigomori/ui/views/worktreeLocation/layoutOptions.ts";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

export function useDeviceLayout(): DeviceLayout | null {
  const { data: runtime } = useRuntimeInfo();
  // Silent like the runtime read beside it: a peer that refuses reads
  // gets no path spelled, not a toast per label.
  const { data: globalConfig } = useGlobalConfig({ silentError: true });
  if (!runtime || !globalConfig) return null;
  return {
    dataDir: runtime.dataDir,
    canonicalDataDirName: runtime.canonicalDataDirName,
    homedir: runtime.homedir,
    onProjectDrive:
      globalConfig.managedOnProjectDrive ??
      DEVICE_SETTINGS_DEFAULTS.managedOnProjectDrive,
  };
}
