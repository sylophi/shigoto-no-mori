import { ToggleRow } from "@/components/shared/ToggleRow";
import { useVillagerDataStatus } from "@/hooks/villagers/useVillagerData";
import { villageLifeShows } from "@shared/villageLife";
import { AcNoticeLabel } from "./AcNotice";
import { VillagerDataControl } from "./VillagerDataControl";
import { villageLifeRow } from "./villagerDataView";

// The Village life row with the villager data it needs beside it, in
// Appearance. The data lives in this device's data dir
// (host/lib/villagers.ts), so only the desktop mounts this: a web
// client, which has no device of its own, has no Village life. What
// the setting gates reads useVillageLife, never this field.
export function VillageLifeSetting({
  villageLife,
  onChange,
}: {
  villageLife: boolean;
  onChange: (next: boolean) => void;
}) {
  // The row opens once the villager data is here, all of it. Locked,
  // it reads off, which is what the window shows whatever the stored
  // value (villageLifeShows, the rule every extra follows).
  const { data: villagerData } = useVillagerDataStatus();
  const view = villageLifeRow(villagerData);
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <ToggleRow
          checked={villageLifeShows({ villageLife }, villagerData)}
          onCheckedChange={onChange}
          disabled={view.locked}
          label={<AcNoticeLabel>Village life</AcNoticeLabel>}
          description={view.description}
        />
      </div>
      <VillagerDataControl />
    </div>
  );
}
