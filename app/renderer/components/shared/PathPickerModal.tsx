// The folder browser (PathPickerView) in a modal, listing each folder
// through the hook the caller hands in (carry-over unions every
// checkout, a pull reads its source worktree, the leave-out preset
// unions every device).
import { useState } from "react";
import {
  PathPickerView,
  type PathListing,
  type PathPickerProps,
} from "@/components/shared/PathPickerView";
import type { PickerEntry } from "@/components/shared/PickerRowView";
import { ModalShell } from "@/components/ui/modal-shell";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

export type PathPickerModalProps<E extends PickerEntry> = PathPickerProps<E> & {
  // The listing for one root-relative folder ("" at the root).
  useListing: (relative: string) => PathListing<E>;
};

export function PathPickerModal<E extends PickerEntry>({
  useListing,
  ...props
}: PathPickerModalProps<E>) {
  // The folders stepped into, outermost first, and the browsed folder
  // they spell, root-relative ("" at the root). Relative rather than
  // absolute because the listing may be a union across checkouts or
  // devices: a folder may exist in a worktree and not in the primary,
  // or on a peer and not here.
  const [parents, setParents] = useState<readonly E[]>([]);
  const listing = useListing(parents.map((parent) => parent.name).join("/"));
  const { data: runtime } = useRuntimeInfo();
  return (
    <ModalShell onClose={props.onClose}>
      <PathPickerView
        {...props}
        home={runtime?.homedir ?? null}
        parents={parents}
        onParentsChange={setParents}
        listing={listing}
      />
    </ModalShell>
  );
}
