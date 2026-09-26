import { useEffect, useRef, useState } from "react";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { useAccountStatus } from "@/hooks/account/useAccount";
import {
  DeviceTabBar,
  DeviceTabPanel,
  useDeviceTabs,
  usePickedDevice,
} from "@/components/shared/DeviceTabs";
import { ModalShell } from "@/components/ui/modal-shell";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { localDeviceId } from "@/lib/queryKeys";
import { AddProjectView } from "./addProject/AddProjectView";

// Standalone host for the add-project flow (File → Add project…, ⌘N, and
// the sidebar ＋ button). The shortcut is a native menu accelerator in
// main/electron/menu.ts that broadcasts over IPC.
export function AddProjectModal() {
  const { addProjectOpen, addProjectRequest, openAddProject } = useOverlays();

  useEffect(
    () => window.api.projectLauncher.onAddProject(() => openAddProject()),
    [openAddProject],
  );

  if (!addProjectOpen) return null;
  return <AddProjectDialog key={addProjectRequest} />;
}

// The flow under a device pick: the same browse, scan and add, run on
// whichever machine the tab names. The view reads everything off the
// scope the panel mounts it under, so a peer's disk browses like this
// one's. The bar shows only once there is a choice to make.
function AddProjectDialog() {
  const { addProjectTarget, setAddProjectOpen } = useOverlays();
  const onClose = () => setAddProjectOpen(false);
  // Held here, above the per-device view, so what was typed survives a
  // change of device: a pasted URL is as good on the next machine, and
  // `~/dev/` means the same folder on each.
  const [query, setQuery] = useState(addProjectTarget.query ?? "~/");
  const tabs = useDeviceTabs();
  const { data: status } = useAccountStatus();
  const [picked, pick] = usePickedDevice(
    tabs,
    addProjectTarget.deviceId ?? localDeviceId,
  );

  // Escape is the shell's to hear (it hears it wherever focus sits),
  // and the view's to answer while it has a stage to back out of. The
  // view leaves this null otherwise, and whenever it isn't mounted (a
  // tab that can only show a note), so the key closes the dialog.
  const escapeRef = useRef<(() => void) | null>(null);

  return (
    <ModalShell
      onClose={onClose}
      onEscape={() => (escapeRef.current ?? onClose)()}
    >
      {tabs.length > 1 && picked && (
        <div className="border-b border-border py-2">
          <DeviceTabBar
            tabs={tabs}
            selectedId={picked.deviceId}
            onSelect={pick}
            // phone:px-3 as well: the bar's own phone:px-4 outlives a bare px-3.
            className="px-3 phone:px-3"
          />
        </div>
      )}
      {picked ? (
        <DeviceTabPanel tab={picked} subject="its folder listing">
          <AddProjectView
            query={query}
            setQuery={setQuery}
            onClose={onClose}
            escapeRef={escapeRef}
          />
        </DeviceTabPanel>
      ) : (
        <div className="p-6">
          <EmptyPanel>
            {status?.signedIn === true
              ? "No device that holds projects is signed in to this account."
              : "Sign in to add a project from one of the account's devices."}
          </EmptyPanel>
        </div>
      )}
    </ModalShell>
  );
}
