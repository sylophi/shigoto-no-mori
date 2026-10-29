// How far a clone has got, as the device running it pushes it, null
// until it first says. A device on an older build never does.
import { useEffect, useState } from "react";
import {
  type CloneFromDeviceProgress,
  projectsContract,
  type CloneProgress,
} from "@shigomori/contracts/modules/projects";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";

// The clone into `parentDir/name` on the scoped device.
export function useCloneProgress(
  parentDir: string | null,
  name: string | null,
): CloneProgress | null {
  const { api } = useHostScope();
  const [progress, setProgress] = useState<CloneProgress | null>(null);
  useEffect(() => {
    if (parentDir === null) return;
    const stop = api.listen(
      api.pushes(projectsContract, "cloneProgress"),
      (push) => {
        if (push.parentDir === parentDir && push.name === name) {
          setProgress(push.progress);
        }
      },
    );
    return () => {
      stop();
      setProgress(null);
    };
  }, [api, parentDir, name]);
  return progress;
}

// The clone of `deviceId`'s project `projectId` that `api`'s device runs
// (projects:cloneFromDevice).
export function useCloneFromDeviceProgress(
  api: HostApi,
  deviceId: string,
  projectId: string,
): CloneFromDeviceProgress | null {
  const [progress, setProgress] = useState<CloneFromDeviceProgress | null>(
    null,
  );
  useEffect(
    () =>
      api.listen(
        api.pushes(projectsContract, "cloneFromDeviceProgress"),
        (push) => {
          if (push.deviceId === deviceId && push.projectId === projectId) {
            setProgress(push);
          }
        },
      ),
    [api, deviceId, projectId],
  );
  return progress;
}
