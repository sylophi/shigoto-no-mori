import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useState } from "react";
import { FolderInput, FolderOpen, RotateCcw } from "lucide-react";
import { BlockingOverlay } from "@/components/ui/blocking-overlay";
import { Button } from "@/components/ui/button";
import { FolderPickerModal } from "@/components/ui/folder-picker-modal";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { getBrowseParentPath } from "@/lib/projectPaths";
import { notifyError } from "@/lib/toast";

// Where the shigomori data dir lives, and the flow that moves it. The
// picker (the in-app FolderPickerModal, which still offers Finder on
// this machine) chooses the new PARENT and the folder lands under its
// canonical name (the main process owns that rule in
// lib/dataDirMove.ts). A folder away from the default location gets a
// Reset button, which is the same move with no parent given. On success
// the main process relaunches the app, so the overlay's job is just to
// block interaction until the window goes away.
export function DataLocationSection() {
  const { data: runtime } = useRuntimeInfo();
  const root = runtime?.dataDir ?? null;
  const home = runtime?.homedir ?? null;
  const [moving, setMoving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The move is refused when this session's data dir came from
  // SHIGOMORI_DATA_DIR (a sandbox owns it), so don't offer it.
  const movable = runtime !== undefined && runtime.dataDirSource !== "env";

  const moveTo = async (parent?: string) => {
    setMoving(true);
    try {
      await window.api.runtime.moveDataDir(parent);
      // Acknowledge: the main process relaunches only after this call,
      // which can't fire before the moveDataDir reply above was delivered.
      // Fire-and-forget, because the app quits out from under the promise.
      void window.api.window.relaunch();
    } catch (err) {
      notifyError("Couldn't move data folder", err);
      setMoving(false);
    }
  };

  // Reset to the default location, which the host resolves. Two clicks,
  // since the app restarts on the spot and the first click is the
  // moment to learn that.
  const reset = useConfirmTwice(CONFIRM_QUICK_MS);
  const handleReset = () => reset.trigger(() => void moveTo());

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
          Reveal in Finder
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!movable || moving}
          onClick={() => setPickerOpen(true)}
        >
          <FolderInput />
          Move data folder…
        </Button>
        {movable && !runtime.atDefaultDataDir && (
          <Button
            variant="outline"
            size="sm"
            disabled={moving}
            aria-pressed={reset.armed}
            onClick={handleReset}
          >
            <RotateCcw />
            {reset.armed ? "Reset and restart?" : "Reset to default"}
          </Button>
        )}
      </div>
      {pickerOpen && runtime && (
        <FolderPickerModal
          // Start beside the current folder: the common move is to a
          // sibling location, and the parent is where "here" resolves.
          initialPath={getBrowseParentPath(runtime.dataDir) ?? undefined}
          title="Move the data folder"
          confirmLabel="Move here"
          hint={`Choose its new parent folder. It will be named ${runtime.canonicalDataDirName} there, and the app restarts right after the move.`}
          onPick={(parent) => {
            setPickerOpen(false);
            void moveTo(parent);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
