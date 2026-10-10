import { useUpdateAll } from "@/hooks/system/useUpdater";
import type { OutdatedDevice } from "@/lib/updates";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { UpdateAllButtonView } from "./UpdateAllButtonView";

// Update all (UpdateAllButtonView) over the devices behind.
export function UpdateAllButton({ outdated }: { outdated: Outdated }) {
  const install = useUpdateAll(outdated);
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  return (
    <UpdateAllButtonView
      armed={confirm.armed}
      pending={install.isPending}
      onClick={() => confirm.trigger(() => install.mutate())}
    />
  );
}

type Outdated = Readonly<Record<string, OutdatedDevice>>;

// Whether Update all is worth offering: one device behind is its own
// Restart to update.
export function offersUpdateAll(outdated: Outdated): boolean {
  return Object.keys(outdated).length >= 2;
}
