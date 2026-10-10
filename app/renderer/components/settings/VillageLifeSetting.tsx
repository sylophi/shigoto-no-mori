import { useVillagerDataStatus } from "@/hooks/villagers/useVillagerData";
import { villageLifeShows } from "@shared/villageLife";
import { VillageLifeSettingView } from "@shigomori/ui/views/settings/VillageLifeSettingView.tsx";
import { VillagerDataControl } from "./VillagerDataControl";
import { villageLifeRow } from "@shigomori/ui/views/settings/villagerDataView.ts";

// Village life's switches (VillageLifeSettingView) over the villager
// data's state on this device.
export function VillageLifeSetting({
  villageLife,
  ...props
}: {
  villageLife: boolean;
  onVillageLifeChange: (next: boolean) => void;
  villageNews: boolean;
  onVillageNewsChange: (next: boolean) => void;
}) {
  const { data: villagerData } = useVillagerDataStatus();
  return (
    <VillageLifeSettingView
      {...props}
      view={villageLifeRow(villagerData)}
      shows={villageLifeShows({ villageLife }, villagerData)}
      dataControl={<VillagerDataControl />}
    />
  );
}
