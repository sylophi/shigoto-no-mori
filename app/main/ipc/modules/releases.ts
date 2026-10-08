// The changelog's release list, fetched from the main process so the
// renderer never talks to GitHub itself.
import { releasesContract } from "@shigomori/contracts/modules/releases";
import type { Handlers } from "@shigomori/contracts/types";
import { fetchReleases } from "@shared/releases";

export const releasesHandlers: Handlers<typeof releasesContract> = {
  list: () => fetchReleases(),
};
