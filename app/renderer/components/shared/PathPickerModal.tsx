// The folder browser (PathPickerView) in a modal. The caller lists the
// browsed folder through its own hook (carry-over unions every
// checkout, a pull reads its source worktree, the leave-out preset
// unions every device), for the folder `usePathSteps` spells.
import { useState } from "react";
import {
  PathPickerView,
  type PathListing,
  type PathPickerProps,
} from "@shigomori/ui/views/shared/PathPickerView.tsx";
import type { PickerEntry } from "@shigomori/ui/views/shared/PickerRowView.tsx";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

// The folders stepped into, outermost first, and the browsed folder
// they spell, root-relative ("" at the root). Relative rather than
// absolute because the listing may be a union across checkouts or
// devices: a folder may exist in a worktree and not in the primary, or
// on a peer and not here.
export function usePathSteps<E extends PickerEntry>() {
  const [parents, setParents] = useState<readonly E[]>([]);
  return {
    parents,
    setParents,
    relative: parents.map((parent) => parent.name).join("/"),
  };
}

export function PathPickerModal<E extends PickerEntry>({
  steps,
  listing,
  ...props
}: PathPickerProps<E> & {
  steps: ReturnType<typeof usePathSteps<E>>;
  // The listing of the folder `steps` spells.
  listing: PathListing<E>;
}) {
  const { data: runtime } = useRuntimeInfo();
  return (
    <ModalShell label="Browse folders" onClose={props.onClose}>
      <PathPickerView
        {...props}
        home={runtime?.homedir ?? null}
        parents={steps.parents}
        onParentsChange={steps.setParents}
        listing={listing}
      />
    </ModalShell>
  );
}
