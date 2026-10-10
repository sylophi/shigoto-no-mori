import { useEffect, useRef, useState } from "react";
import { repoNameFromUrl } from "@shared/cloneUrl";
import { useAccountStatus } from "@/hooks/account/useAccount";
import {
  DeviceTabPanel,
  useDeviceTabs,
  usePickedDevice,
} from "@/components/shared/DeviceTabs";
import { DeviceTabBarView } from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { localDeviceId } from "@/lib/queryKeys";
import { AddExistingForm } from "./addProject/AddExistingForm";
import { CloneForm } from "./addProject/CloneForm";
import { CreateForm } from "./addProject/CreateForm";
import {
  type AddProjectMode,
  AddProjectHeaderView,
  AddProjectNoDeviceView,
} from "@shigomori/ui/views/AddProjectModalView.tsx";

// Standalone host for the add-project flow (File → Add project…, ⌘N, and
// the sidebar ＋ button). The shortcut is a native menu accelerator in
// main/electron/menu.ts that broadcasts over IPC.
export function AddProjectModal() {
  const { addProjectOpen, addProjectRequest, openAddProject } = useOverlays();

  useEffect(
    () => window.api.nav.onAddProject(() => openAddProject()),
    [openAddProject],
  );

  if (!addProjectOpen) return null;
  return <AddProjectDialog key={addProjectRequest} />;
}

// The three ways to a project (an existing repo, a clone, a new one)
// under a device pick, run on whichever machine the tab names. The
// views read everything off the scope the panel mounts them under, so
// a peer's disk browses like this one's. The device bar shows only
// once there is a choice to make.
function AddProjectDialog() {
  const { addProjectTarget, setAddProjectOpen } = useOverlays();
  const onClose = () => setAddProjectOpen(false);
  // A target's query is a path to browse or a URL to clone.
  const targetUrl =
    addProjectTarget.query !== undefined &&
    repoNameFromUrl(addProjectTarget.query) !== null
      ? addProjectTarget.query
      : null;
  const [mode, setMode] = useState<AddProjectMode>(
    targetUrl === null ? "existing" : "clone",
  );
  // Held here, above the per-device views, so what was typed survives a
  // change of device: a pasted URL is as good on the next machine, and
  // `~/dev/` means the same folder on each.
  const [query, setQuery] = useState(
    targetUrl === null ? (addProjectTarget.query ?? "~/") : "~/",
  );
  const [url, setUrl] = useState(targetUrl ?? "");
  const [name, setName] = useState("");
  // A URL typed or pasted where a path goes is a clone, after the `~/`
  // the input starts with.
  const setPathOrUrl = (value: string) => {
    const pasted = value.replace(/^~\//, "");
    if (repoNameFromUrl(pasted) === null) {
      setQuery(value);
      return;
    }
    setUrl(pasted);
    setMode("clone");
  };
  // Held here for the same reason. On by default: a device that lists
  // terrier's repos as projects has terrier as its registry.
  const [addToTerrier, setAddToTerrier] = useState(true);
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
      label="Add project"
      onClose={onClose}
      onEscape={() => (escapeRef.current ?? onClose)()}
    >
      <AddProjectHeaderView
        mode={mode}
        onMode={setMode}
        tabs={
          tabs.length > 1 &&
          picked && (
            <DeviceTabBarView
              tabs={tabs}
              selectedId={picked.deviceId}
              onSelect={pick}
              // phone:px-3 as well: the bar's own phone:px-4 outlives a bare px-3.
              className="px-3 phone:px-3"
            />
          )
        }
      />
      {picked ? (
        <DeviceTabPanel tab={picked} subject="its folder listing">
          {mode === "existing" && (
            <AddExistingForm
              query={query}
              setQuery={setPathOrUrl}
              addToTerrier={addToTerrier}
              setAddToTerrier={setAddToTerrier}
              onClose={onClose}
              escapeRef={escapeRef}
            />
          )}
          {mode === "clone" && (
            <CloneForm
              url={url}
              setUrl={setUrl}
              addToTerrier={addToTerrier}
              setAddToTerrier={setAddToTerrier}
              onClose={onClose}
            />
          )}
          {mode === "create" && (
            <CreateForm
              name={name}
              setName={setName}
              addToTerrier={addToTerrier}
              setAddToTerrier={setAddToTerrier}
              onClose={onClose}
            />
          )}
        </DeviceTabPanel>
      ) : (
        <AddProjectNoDeviceView signedIn={status?.signedIn === true} />
      )}
    </ModalShell>
  );
}
