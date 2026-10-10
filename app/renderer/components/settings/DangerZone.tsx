import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NukeProgress } from "@shigomori/contracts/schemas";
import { setOpenProject } from "@/components/sidebar/openProject";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { tildify } from "@shigomori/contracts/projectPaths";
import { notifyError } from "@/lib/toast";
import { DangerZoneView } from "./DangerZoneView";

export function DangerZone() {
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const [nuking, setNuking] = useState(false);
  const [progress, setProgress] = useState<NukeProgress | null>(null);

  useEffect(() => window.api.runtime.onNukeProgress(setProgress), []);

  const home = runtime?.homedir ?? null;
  const root = runtime?.dataDir ? tildify(runtime.dataDir, home) : "~/.sm";

  const handleNuke = () => {
    trigger(async () => {
      setNuking(true);
      setProgress(null);
      try {
        await window.api.runtime.nuke();
        // One rule decides what a nuke covers: this host's data dir
        // goes, and so does this machine's shigomori install (the CLI
        // and its shell hooks), while preferences survive because they
        // are preferences, not data. Appearance therefore stays put:
        // it lives as client config in the app's own userData, and the
        // localStorage boot hints stay valid.
        // Every cached query now describes deleted state. A blanket
        // invalidateQueries() would refetch them all against the wiped
        // data dir and raise a burst of "Unknown project/worktree" toasts,
        // with retries landing even after the navigation below. Cancel
        // in-flight fetches and drop the cache BEFORE navigating, so
        // "/" never draws pre-nuke data.
        await queryClient.cancelQueries();
        queryClient.clear();
        // The sidebar's open project is kept outside the cache, and a
        // repo added back would open inside it. Back to the list.
        setOpenProject(null);
        // The store went with the data dir: the app starts again on a
        // fresh one.
        void window.api.window.relaunch();
      } catch (err) {
        notifyError("Couldn't nuke shigomori data", err);
      }
      // The catch above swallows every failure, so this runs on all paths
      // (a `finally` clause would bail React Compiler out of this component).
      setNuking(false);
    });
  };

  return (
    <DangerZoneView
      root={root}
      nuking={nuking}
      progress={progress}
      armed={armed}
      onNuke={handleNuke}
    />
  );
}
