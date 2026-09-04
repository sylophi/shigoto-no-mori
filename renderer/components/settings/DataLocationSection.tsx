import { useState } from "react";
import { FolderInput, FolderOpen, FolderPen } from "lucide-react";
import { BlockingOverlay } from "@/components/ui/blocking-overlay";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { notifyError } from "@/lib/toast";

// Where the shigomori data dir lives, and the flow that moves it. The
// picker chooses the new PARENT and the folder lands under its
// canonical name (the main process owns that rule -- see
// lib/dataDirMove.ts). A folder boot adopted under its pre-2.0 name
// gets a Rename button, which is the same move with no parent given. On success the main process relaunches the app, so the
// overlay's job is just to block interaction until the window goes
// away.
export function DataLocationSection() {
  const { data: runtime } = useRuntimeInfo();
  const root = runtime?.dataDir ?? null;
  const home = runtime?.homedir ?? null;
  const [moving, setMoving] = useState(false);

  // The move is refused when this session's data dir came from
  // SHIGOMORI_DATA_DIR (a sandbox owns it), so don't offer it.
  const movable = runtime !== undefined && runtime.dataDirSource !== "env";

  const moveTo = async (parent?: string) => {
    setMoving(true);
    try {
      await window.api.runtime.moveDataDir(parent);
      // Acknowledge: the main process relaunches only after this call,
      // which can't fire before the moveDataDir reply above was delivered.
      // Fire-and-forget -- the app quits out from under the promise.
      void window.api.window.relaunch();
    } catch (err) {
      notifyError("Couldn't move data folder", err);
      setMoving(false);
    }
  };

  const handleMove = async () => {
    if (!runtime) return;
    let parent: string | null = null;
    try {
      parent = await window.api.dialog.pickFolder({
        title: "Move the data folder",
        buttonLabel: "Move here",
        message: `Choose its new parent folder. It will be named ${runtime.canonicalDataDirName} there.`,
      });
    } catch (err) {
      // A real dialog/IPC failure, distinct from the user cancelling
      // (which resolves to null).
      notifyError("Couldn't open the folder picker", err);
      return;
    }
    if (!parent) return;
    await moveTo(parent);
  };

  // Rename in place: the host resolves the current parent.
  const handleRename = () => moveTo();

  return (
    <section className="space-y-3">
      {moving && (
        <BlockingOverlay>
          Moving data folder… The app will restart.
        </BlockingOverlay>
      )}
      <SectionHeading className="mb-1">Data location</SectionHeading>
      {root && (
        <div className="flex font-mono text-sm select-text">
          <PathSpan
            path={root}
            home={home}
            className="min-w-0 flex-1 truncate"
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Worktrees, configs, and state live here. Moving the folder restarts the
        app, and the CLI follows automatically.
      </p>
      {runtime?.dataDirSource === "legacy" && (
        <p className="text-xs text-muted-foreground">
          This folder still has its pre-2.0 name. Rename it to{" "}
          {runtime.canonicalDataDirName} to keep worktree paths short.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!root}
          onClick={() => {
            if (root) {
              window.api.shell
                .showItemInFolder(root)
                .catch((err) => notifyError("Couldn't reveal folder", err));
            }
          }}
        >
          <FolderOpen />
          Reveal in Finder
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!movable || moving}
          onClick={() => void handleMove()}
        >
          <FolderInput />
          Move data folder…
        </Button>
        {runtime?.dataDirSource === "legacy" && (
          <Button
            variant="outline"
            size="sm"
            disabled={!movable || moving}
            onClick={() => void handleRename()}
          >
            <FolderPen />
            Rename to {runtime.canonicalDataDirName}
          </Button>
        )}
      </div>
    </section>
  );
}
