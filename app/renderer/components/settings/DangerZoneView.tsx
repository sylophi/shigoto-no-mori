import { Flame } from "lucide-react";
import type { NukeProgress } from "@shigomori/contracts/schemas";
import { BlockingOverlay } from "@/components/ui/blocking-overlay";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";

// This machine's nuke: everything shigomori made, gone. DangerZone runs
// it.
export function DangerZoneView({
  root,
  nuking,
  progress,
  armed,
  onNuke,
}: {
  // The data folder it deletes, tildified.
  root: string;
  nuking: boolean;
  progress: NukeProgress | null;
  // Asked once: the next click nukes.
  armed: boolean;
  onNuke: () => void;
}) {
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
          onClick={onNuke}
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
