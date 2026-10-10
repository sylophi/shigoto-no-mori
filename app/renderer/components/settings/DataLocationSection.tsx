import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { useState } from "react";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { getBrowseParentPath } from "@shigomori/contracts/projectPaths";
import { notifyError, toast } from "@/lib/toast";
import { DataLocationSectionView } from "./DataLocationSectionView";

// Where the shigomori data dir lives (DataLocationSectionView), and
// the move that relaunches the app holding it.
export function DataLocationSection() {
  const { api, remote } = useHostScope();
  // Whose app the copy below is talking about.
  const there = remote ? " on that device" : "";
  const { data: runtime } = useRuntimeInfo();
  const root = runtime?.dataDir ?? null;
  const home = runtime?.homedir ?? null;
  const [moving, setMoving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The folder a peer's move just left. Its app is restarting, and
  // until the session that lands afterwards re-reads the path, the
  // cached one is this stale one and another move would be aimed at a
  // folder that is gone. Derived against `root`, so it clears itself.
  const [movedFrom, setMovedFrom] = useState<string | null>(null);
  const restarting = movedFrom !== null && movedFrom === root;
  const busy = moving || restarting;

  // The move is refused when this session's data dir came from
  // SHIGOMORI_DATA_DIR (a sandbox owns it), so don't offer it.
  const movable = runtime !== undefined && runtime.dataDirSource !== "env";

  const moveTo = async (parent?: string) => {
    setMoving(true);
    try {
      await api.runtime.moveDataDir({ parentDir: parent });
      if (remote) {
        toast.success(`Data folder moved. The app${there} is restarting.`);
        setMovedFrom(root);
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
    <DataLocationSectionView
      remote={remote}
      root={root}
      home={home}
      moving={moving}
      busy={busy}
      movable={movable}
      atDefault={runtime?.atDefaultDataDir ?? true}
      resetArmed={reset.armed}
      onReveal={() => {
        if (root) {
          window.api.shell
            .showItemInFolder({ path: root })
            .catch((err) => notifyError("Couldn't reveal folder", err));
        }
      }}
      onPickParent={() => setPickerOpen(true)}
      onReset={handleReset}
      picker={
        pickerOpen &&
        runtime && (
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
        )
      }
    />
  );
}
