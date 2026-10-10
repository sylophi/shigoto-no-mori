import { useVillagerData } from "@/hooks/villagers/useVillagerData";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { VillagerDataControlView } from "@shigomori/ui/views/settings/VillagerDataControlView.tsx";
import { villagerDataView } from "@shigomori/ui/views/settings/villagerDataView.ts";

// The villager data's control (VillagerDataControlView), bound to its
// download, cancel and removal.
export function VillagerDataControl() {
  const { status, download, cancel, remove } = useVillagerData();
  const confirmRemove = useConfirmTwice(CONFIRM_QUICK_MS);
  // Nothing to say until the status is known.
  if (status === undefined) return null;
  const view = villagerDataView(status);
  return (
    <VillagerDataControlView
      view={view}
      armed={confirmRemove.armed}
      removePending={remove.isPending}
      disabled={download.isPending || cancel.isPending || remove.isPending}
      onRemove={() => confirmRemove.trigger(() => remove.mutate())}
      onAction={() =>
        view.action === "cancel" ? cancel.mutate() : download.mutate()
      }
    />
  );
}
