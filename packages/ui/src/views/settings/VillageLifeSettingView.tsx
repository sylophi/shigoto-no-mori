import { Info } from "lucide-react";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import type { ReactNode } from "react";
import acNotice from "../../lib/acNotice.json";
import type { villageLifeRow } from "./villagerDataView.ts";

// Shown on hover beside the label, since this is the setting that
// brings Animal Crossing's villagers along. The name pool's entry in
// the bundled third-party licenses opens with the same text.
const AC_NOTICE = acNotice.notice;

// The Village life row with the villager data it needs beside it, in
// Appearance. The data lives in this device's data dir
// (host/lib/villagers.ts), so only the desktop mounts this: a web
// client, which has no device of its own, has no Village life. What
// the setting gates reads useVillageLife, never this field.
export function VillageLifeSettingView({
  view,
  shows,
  onVillageLifeChange,
  villageNews,
  onVillageNewsChange,
  dataControl,
}: {
  // The row as the villager data leaves it (villagerDataView.ts).
  view: ReturnType<typeof villageLifeRow>;
  // The row opens once the villager data is here, all of it. Locked,
  // it reads off, which is what the window shows whatever the stored
  // value (villageLifeShows, the rule every extra follows).
  shows: boolean;
  onVillageLifeChange: (next: boolean) => void;
  villageNews: boolean;
  onVillageNewsChange: (next: boolean) => void;
  // The villager data's download, beside the switches.
  dataControl: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 space-y-3">
        <ToggleRowView
          checked={shows}
          onCheckedChange={onVillageLifeChange}
          disabled={view.locked}
          label={
            <span className="inline-flex items-center gap-1.5">
              Village life
              {/* A button, so the icon is focusable and a click on it
                  (preventDefault) doesn't flip the row's switch. No
                  hover delay: the icon is only there to show this. */}
              <SimpleTooltip tip={AC_NOTICE} delay={0}>
                <button
                  type="button"
                  aria-label={AC_NOTICE}
                  onClick={(e) => e.preventDefault()}
                  className="inline-flex rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <Info aria-hidden className="size-3.5" />
                </button>
              </SimpleTooltip>
            </span>
          }
          description={view.description}
        />
        <div className="pl-11">
          <ToggleRowView
            checked={shows && villageNews}
            onCheckedChange={onVillageNewsChange}
            disabled={!shows}
            label="Village news"
            description="Villagers say when they move in or out."
          />
        </div>
      </div>
      {dataControl}
    </div>
  );
}
