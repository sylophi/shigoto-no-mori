import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useState } from "react";
import { FolderInput, FolderOpen, RotateCcw } from "lucide-react";
import { BlockingOverlay } from "@/components/ui/blocking-overlay";
import { Button } from "@/components/ui/button";
import { FolderPickerModal } from "@/components/ui/folder-picker-modal";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { getBrowseParentPath } from "@/lib/projectPaths";
import { notifyError, toast } from "@/lib/toast";

// Where the shigomori data dir lives, and the flow that moves it. The
// picker (the in-app FolderPickerModal, which still offers Finder on
// this machine) chooses the new PARENT and the folder lands under its
// canonical name (the main process owns that rule in
// lib/dataDirMove.ts). A folder away from the default location gets a
// Reset button, which is the same move with no parent given. On success
// the main process relaunches the app, so the overlay's job is just to
// block interaction until the window goes away.
//
// Host-scoped: mounted for a peer, the same flow moves THAT device's
// folder. The peer's app relaunches itself after answering (this
// window has no say in another machine's lifecycle), this window
// stays up, and the session that lands when the peer is back refetches
// its runtime info, so the new path shows up on its own.
export function DataLocationSection() {
  const { api, remote } = useHostScope();
  // Whose app the copy below is talking about.
  const there = remote ? " on that device" : "";
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
      await api.runtime.moveDataDir(parent);
      if (remote) {
        toast.success(`Data folder moved. The app${there} is restarting.`);
        setMoving(false);
        return;
      }
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
          Moving data folder… The app{there} will restart.
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
        app{there}, and the CLI follows automatically.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* This machine's Finder can only show this machine's disk. */}
        {!remote && (
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
        )}
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
          hint={`Choose its new parent folder. It will be named ${runtime.canonicalDataDirName} there, and the app${there} restarts right after the move.`}
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
