import { useEffect, useRef, useState } from "react";
import { defaultCloneParent } from "@shared/cloneDestination";
import { ensureTrailingSep, tildify } from "@shigomori/contracts/projectPaths";
import type { Project } from "@shigomori/contracts/schemas";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { useProjects } from "@/hooks/projects/useProjects";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { toast } from "@/lib/toast";
import { useTerrierOptIn } from "./TerrierOptIn";
import { useOpenAddedProject } from "./useOpenAddedProject";

// What the clone and the new repository share: where the checkout lands
// (the device's usual folder, or one picked), the input that submits
// it, the terrier opt-in, and how the flow ends.
export function useNewCheckout({
  folder,
  pickerTitle,
  addToTerrier,
  setAddToTerrier,
  onClose,
}: {
  // The new folder's name, empty while there is none yet.
  folder: string;
  pickerTitle: string;
  addToTerrier: boolean;
  setAddToTerrier: (value: boolean) => void;
  onClose: () => void;
}) {
  const scope = useHostScope();
  const { data: projects = [] } = useProjects();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const openAdded = useOpenAddedProject();
  // The picked parent folder. Null follows the device's own layout.
  const [pickedParent, setPickedParent] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The picker takes focus while it is up. Handing it back puts the
  // next ↩ where the view listens, so the pick and the submit are two
  // keys with no click between them.
  const inputRef = useRef<HTMLInputElement>(null);
  const closePicker = () => {
    setPickerOpen(false);
    inputRef.current?.focus();
  };
  const { terrier, terrierOptIn } = useTerrierOptIn(
    addToTerrier,
    setAddToTerrier,
    inputRef,
  );
  // Only a peer's name is worth saying. The hook's own fallback covers a
  // peer that leaves the registry midway, so the wording never slides
  // back to this device's.
  const peerLabel = useRemoteDeviceLabel(scope.deviceId);
  const onDevice = scope.remote ? ` on ${peerLabel}` : "";
  // A clone or a publish outlives the dialog, so what follows has to
  // know whether anyone is still looking.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const parent = pickedParent ?? defaultCloneParent(projects, home);
  // Tildified here, once: a picked parent comes back as the device
  // resolved it, absolute.
  const dest = tildify(`${parent}${folder}`, home);

  // Lands on the project, or, closed meanwhile, says it landed and
  // leaves the user where they are.
  const finish = (project: Project, made: string) => {
    if (!mounted.current) {
      toast.success(`${made} ${project.name}${onDevice}`);
      return;
    }
    onClose();
    void openAdded(project.id);
  };

  const picker = pickerOpen && (
    <FolderPickerModal
      initialPath={parent}
      title={pickerTitle}
      hint={`${folder || "The repository"} becomes a new folder inside the one you pick.`}
      onPick={(picked) => {
        setPickedParent(ensureTrailingSep(picked));
        closePicker();
      }}
      onClose={closePicker}
    />
  );

  return {
    parent,
    dest,
    inputRef,
    terrier,
    terrierOptIn,
    onDevice,
    finish,
    openPicker: () => setPickerOpen(true),
    picker,
  };
}
