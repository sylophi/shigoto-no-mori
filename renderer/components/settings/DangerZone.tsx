import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Flame } from "lucide-react";
import type { NukeProgress } from "@shared/schemas";
import { BlockingOverlay } from "@/components/ui/blocking-overlay";
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
  const [progress, setProgress] = useState<NukeProgress | null>(null);

  useEffect(() => window.api.runtime.onNukeProgress(setProgress), []);

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";

  const handleNuke = () => {
    trigger(async () => {
      setNuking(true);
      setProgress(null);
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
        // in-flight fetches and drop the cache BEFORE navigating: the
        // "/" route redirects to the first worktree it finds in cache
        // (EmptyState's resolver), so navigating while pre-nuke data is
        // still cached bounces straight back to a dead worktree view.
        await queryClient.cancelQueries();
        queryClient.clear();
        await navigate({ to: "/" });
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
      {nuking && (
        <BlockingOverlay>{describeNukeProgress(progress)}</BlockingOverlay>
      )}
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

// Shown under the BlockingOverlay while the nuke IPC runs:
// force-removing worktrees and reaping scripts takes seconds, and
// letting the user keep clicking around (starting scripts, deleting
// worktrees) mid-wipe invites the races the delete-inflight guards
// exist to catch.
function describeNukeProgress(progress: NukeProgress | null): string {
  if (!progress) return "Preparing…";
  switch (progress.phase) {
    case "scripts":
      return "Stopping running scripts…";
    case "worktrees":
      return progress.total > 0
        ? `Removing worktrees (${progress.done}/${progress.total})…`
        : "Removing worktrees…";
    case "wipe":
      return "Wiping shigomori data…";
  }
}
