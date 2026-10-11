import { Flame } from "lucide-react";
import type {
  NukeProgress,
  NukeReport,
} from "@shigomori/contracts/schemas/index";
import { BlockingOverlay } from "../../primitives/blocking-overlay.tsx";
import { Button } from "../../primitives/button.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";

// This machine's nuke: everything shigomori made, gone, and the next
// start a fresh install. DangerZone runs it.
export function DangerZoneView({
  root,
  nuking,
  progress,
  left,
  armed,
  onNuke,
  onRelaunch,
}: {
  // The data folder it deletes, tildified.
  root: string;
  nuking: boolean;
  progress: NukeProgress | null;
  // What a finished nuke could not do, which waits on a relaunch.
  left: NukeReport["left"] | null;
  // Asked once: the next click nukes.
  armed: boolean;
  onNuke: () => void;
  onRelaunch: () => void;
}) {
  return (
    <section className="space-y-3">
      {nuking && (
        <BlockingOverlay>{describeNukeProgress(progress)}</BlockingOverlay>
      )}
      {left !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="max-w-md space-y-3 px-4">
            <p className="text-sm">
              Nuked, except for what follows. The rest goes as the app restarts.
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {left.map((item) => (
                <li key={item.what}>
                  <span className="font-medium text-foreground">
                    {item.what}
                  </span>
                  : {item.why}
                </li>
              ))}
            </ul>
            <Button size="sm" onClick={onRelaunch}>
              Restart
            </Button>
          </div>
        </div>
      )}
      <SectionHeading className="mb-1">Danger zone</SectionHeading>
      <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-destructive">
            Nuke everything
          </div>
          <p className="text-xs text-muted-foreground">
            Force-removes every worktree shigomori created, removes its command
            line tool and hooks, takes this device off your account, and deletes
            everything under <span className="font-mono">{root}</span> along
            with the app's settings and logs. The app restarts as a fresh
            install. The original project repos on disk are not touched.
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
    case "hooks":
      return "Removing the command line tool…";
  }
}
