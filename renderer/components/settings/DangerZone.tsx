import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Flame } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { DOUBUTSU_STORAGE_KEY } from "@/hooks/ui/useDoubutsu";
import { THEME_STORAGE_KEY } from "@/hooks/ui/useTheme";
import { tildify } from "@/lib/projectPaths";
import { notifyError } from "@/lib/toast";

export function DangerZone() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const [nuking, setNuking] = useState(false);

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";

  const handleNuke = () => {
    trigger(async () => {
      setNuking(true);
      try {
        await window.api.runtime.nuke();
        try {
          window.localStorage.removeItem(THEME_STORAGE_KEY);
          window.localStorage.removeItem(DOUBUTSU_STORAGE_KEY);
        } catch {
          // localStorage may be unavailable; not fatal.
        }
        // Every cached query now describes deleted state. A blanket
        // invalidateQueries() would refetch them all against the wiped
        // root and raise a burst of "Unknown project/worktree" toasts,
        // with retries landing even after the navigation below. Cancel
        // in-flight fetches, leave the dead route, then drop the cache
        // so only the queries mounted on "/" refetch -- those all read
        // the freshly reseeded empty root cleanly.
        await queryClient.cancelQueries();
        await navigate({ to: "/" });
        queryClient.clear();
      } catch (err) {
        notifyError("Couldn't nuke shigomori data", err);
      }
      // The catch above swallows every failure, so this runs on all paths
      // (a `finally` clause would bail React Compiler out of this component).
      setNuking(false);
    });
  };

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Danger zone</SectionHeading>
      <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-destructive">
            Nuke everything
          </div>
          <p className="text-xs text-muted-foreground">
            Force-removes every worktree shigomori created, drops the project
            registry, and deletes all configs and state under{" "}
            <span className="font-mono">{root}</span>. The original project
            repos on disk are not touched.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={nuking}
          onClick={handleNuke}
          title={
            armed
              ? "Click again to confirm. This cannot be undone."
              : "Wipe all shigomori data"
          }
        >
          <Flame />
          {nuking
            ? "Nuking…"
            : armed
              ? "Click again to confirm"
              : "Nuke everything"}
        </Button>
      </div>
    </section>
  );
}
