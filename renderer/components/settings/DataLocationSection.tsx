import { useState } from "react";
import { FolderInput, FolderOpen } from "lucide-react";
import { BlockingOverlay } from "@/components/ui/blocking-overlay";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { fileManagerName } from "@/lib/platform";
import { notifyError } from "@/lib/toast";

// Where the shigomori state root lives, and the flow that moves it.
// The picker chooses the new PARENT and the folder keeps its name (the
// main process owns that rule -- see lib/rootMove.ts). On success the
// main process relaunches the app, so the overlay's job is just to
// block interaction until the window goes away.
export function DataLocationSection() {
  const { data: runtime } = useRuntimeInfo();
  const root = runtime?.shigomoriRoot ?? null;
  const home = runtime?.homedir ?? null;
  const [moving, setMoving] = useState(false);

  const handleMove = async () => {
    if (!runtime) return;
    let parent: string | null = null;
    try {
      parent = await window.api.dialog.pickFolder({
        title: `Choose where the ${runtime.rootDirName} folder should live`,
        buttonLabel: "Move here",
        message: `The ${runtime.rootDirName} folder (worktrees, configs, state) will move into the folder you choose, keeping its name. The app restarts afterwards.`,
      });
    } catch (err) {
      // A real dialog/IPC failure, distinct from the user cancelling
      // (which resolves to null).
      notifyError("Couldn't open the folder picker", err);
      return;
    }
    if (!parent) return;
    setMoving(true);
    try {
      await window.api.runtime.moveRoot(parent);
      // Acknowledge: the main process relaunches only after this call,
      // which can't fire before the moveRoot reply above was delivered.
      // Fire-and-forget -- the app quits out from under the promise.
      void window.api.runtime.relaunch();
    } catch (err) {
      notifyError("Couldn't move data folder", err);
      setMoving(false);
    }
  };

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
          Reveal in {fileManagerName}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!root || moving}
          onClick={() => void handleMove()}
        >
          <FolderInput />
          Move data folder…
        </Button>
      </div>
    </section>
  );
}
