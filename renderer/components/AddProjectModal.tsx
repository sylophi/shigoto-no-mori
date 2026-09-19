import { useEffect, useState } from "react";
import { EmptyPanel } from "@/components/remote/EmptyPanel";
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
// main/menu.ts that broadcasts over IPC.
export function AddProjectModal() {
  const { addProjectOpen, openAddProject } = useOverlays();

  useEffect(
    () => window.api.projectLauncher.onAddProject(() => openAddProject()),
    [openAddProject],
  );

  if (!addProjectOpen) return null;
  return <AddProjectDialog />;
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
  // A browser on the account is a device too, but registers no projects.
  const tabs = useDeviceTabs().filter((tab) => tab.hostsProjects);
  const [picked, pick] = usePickedDevice(
    tabs,
    addProjectTarget.deviceId ?? localDeviceId,
  );

  // AddProjectView owns its own Escape handling (cancels the scan stage,
  // or closes from the browse stage), so the shell must not also close.
  // A tab that can't show the view has nothing to take the key.
  const viewOwnsEscape = picked !== undefined && picked.block === undefined;

  return (
    <ModalShell onClose={onClose} closeOnEscape={!viewOwnsEscape}>
      {tabs.length > 1 && picked && (
        <div className="border-b border-border py-2">
          <DeviceTabBar
            tabs={tabs}
            selectedId={picked.deviceId}
            onSelect={pick}
            className="px-3 phone:px-3"
          />
        </div>
      )}
      {picked ? (
        <DeviceTabPanel tab={picked} subject="its folder listing">
          <AddProjectView query={query} setQuery={setQuery} onClose={onClose} />
        </DeviceTabPanel>
      ) : (
        <div className="p-6">
          <EmptyPanel>
            No device that holds projects is signed in to this account.
          </EmptyPanel>
        </div>
      )}
    </ModalShell>
  );
}
