import type { VillagerDataStatus } from "@shared/schemas";
import { assertNever } from "@/lib/utils";

// What the Village life row and the villager data control under it say
// and offer (DeviceSettingsSections.tsx, VillagerDataControl.tsx). Pure,
// so every state's words are pinned by test/villager-data.mjs.

// The Village life row opens once there are villagers to bring along:
// Doubutsu names on and the villager data downloaded, all of it. Its
// description always says what it is, and while locked, what it
// needs. `status` is undefined while it loads, which locks the row
// without pointing anywhere yet.
export function villageLifeRow(
  doubutsuNames: boolean,
  status: VillagerDataStatus | undefined,
): { locked: boolean; description: string } {
  if (!doubutsuNames) {
    return {
      locked: true,
      description: `${VILLAGE_LIFE} Turn on Doubutsu names to use it.`,
    };
  }
  if (status?.kind !== "ready") {
    return {
      locked: true,
      description:
        status === undefined
          ? VILLAGE_LIFE
          : `${VILLAGE_LIFE} Download villager data from Nookipedia to turn it on.`,
    };
  }
  return { locked: false, description: VILLAGE_LIFE };
}

const VILLAGE_LIFE =
  "Your villagers come to life with a little extra flair around the app. Purely cosmetic.";

export interface VillagerDataView {
  // Nothing before the first download: the button says it all.
  text?: string;
  action: "download" | "cancel" | "remove" | "retry";
  // How far a running download is, 0 to 1.
  progress?: number;
}

export function villagerDataView(status: VillagerDataStatus): VillagerDataView {
  switch (status.kind) {
    case "absent":
      return { action: "download" };
    case "downloading":
      return {
        text: `Downloading… ${status.done} of ${status.villagers}`,
        action: "cancel",
        progress: status.villagers > 0 ? status.done / status.villagers : 0,
      };
    case "ready":
      return {
        text: `Downloaded ${downloadedOn(status.downloadedAt)}`,
        action: "remove",
      };
    case "failed":
      return {
        text:
          status.done > 0
            ? `Stopped at ${status.done} of ${status.villagers}. ${status.message}`
            : status.message,
        action: "retry",
      };
    default:
      return assertNever(status);
  }
}

// "Sep 25", with the year when it isn't this one.
function downloadedOn(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
