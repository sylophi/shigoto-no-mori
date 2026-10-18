import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NukeProgress, NukeReport } from "@shigomori/contracts/schemas";
import { setOpenProject } from "@/components/sidebar/openProject";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { tildify } from "@shigomori/contracts/projectPaths";
import { notifyError } from "@/lib/toast";
import { DangerZoneView } from "@shigomori/ui/views/settings/DangerZoneView.tsx";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { useApi } from "@/lib/runtime/pageApi";

export function DangerZone() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const [nuking, setNuking] = useState(false);
  const [progress, setProgress] = useState<NukeProgress | null>(null);
  const [left, setLeft] = useState<NukeReport["left"] | null>(null);

  useEffect(
    () => api.listen(api.pushes(runtimeContract, "nukeProgress"), setProgress),
    [api],
  );

  const handleNuke = () => {
    trigger(async () => {
      setNuking(true);
      setProgress(null);
      try {
        // The host's half, then the shell's (sign-out, the marker that
        // deletes the files at the next start). Either may leave
        // something it says why for.
        const host = await api.run(api.runtime.nuke());
        const shell = await api.run(api.window.nuke());
        // Every cached query now describes what is going. A blanket
        // invalidateQueries() would refetch them all and raise a burst
        // of "Unknown project/worktree" toasts. Cancel in-flight fetches
        // and drop the cache, so nothing draws the old state.
        await queryClient.cancelQueries();
        queryClient.clear();
        setOpenProject(null);
        const all = [...host.left, ...shell.left];
        if (all.length === 0) {
          void api.run(api.window.relaunch());
          return;
        }
        setLeft(all);
      } catch (err) {
        notifyError("Couldn't nuke shigomori data", err);
      }
      // The catch above swallows every failure, so this runs on all paths
      // (a `finally` clause would bail React Compiler out of this component).
      setNuking(false);
    });
  };

  // Named once this build's data dir is known.
  if (runtime === undefined) return null;
  return (
    <DangerZoneView
      root={tildify(runtime.dataDir, runtime.homedir)}
      nuking={nuking}
      progress={progress}
      left={left}
      armed={armed}
      onNuke={handleNuke}
      onRelaunch={() => void api.run(api.window.relaunch())}
    />
  );
}
