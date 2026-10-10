import type { QueryClient } from "@tanstack/react-query";
import type { VillagerProfiles } from "@shigomori/contracts/schemas";
import { villageLifeEnabled, villageLifeShows } from "@shared/villageLife";
import { clientConfigQueryOptions } from "@/hooks/config/useClientConfig";
import { villagerDataStatusQueryOptions } from "@/hooks/villagers/useVillagerData";
import {
  faceUrl,
  villagerFaceQueryOptions,
  villagerProfilesQueryOptions,
} from "@/hooks/villagers/useVillagers";
import { type Speaker, speakerFor } from "@shigomori/ui/lib/villagerVoice.ts";
import { faceColor } from "./faceColor";

// Who speaks for which worktrees, for a toast fired outside render.
// Same gate as useVillageLife, this window's Village life and villager
// data, read through the same cache entries the hooks use, so a toast
// rarely waits on a read.

// The villager profiles while this window's Village life shows, or
// null. The visit log (visitLog.ts) records under the same gate.
export async function villageProfiles(
  queryClient: QueryClient,
): Promise<VillagerProfiles | null> {
  // No retries: a read that fails leaves the toast plain, now, rather
  // than seconds late.
  const config = await queryClient.ensureQueryData({
    ...clientConfigQueryOptions,
    retry: false,
  });
  if (!villageLifeEnabled(config)) return null;
  const status = await queryClient.ensureQueryData({
    ...villagerDataStatusQueryOptions(),
    retry: false,
  });
  if (!villageLifeShows(config, status)) return null;
  return queryClient.ensureQueryData({
    ...villagerProfilesQueryOptions(),
    retry: false,
  });
}

// The speaker for each worktree named after a character, by worktree
// id. Empty when Village life doesn't show, or when a read
// fails: a toast then stays plain rather than not showing. `withColor`
// reads a rare one's color off their face, for their dialogue box.
export async function speakersFor(
  queryClient: QueryClient,
  worktrees: readonly { id: string; name: string }[],
  { withColor = false }: { withColor?: boolean } = {},
): Promise<Map<string, Speaker>> {
  const speakers = new Map<string, Speaker>();
  const profiles = await villageProfiles(queryClient).catch(() => null);
  if (profiles === null) return speakers;
  await Promise.all(
    worktrees.map(async ({ id, name }) => {
      const speaker = speakerFor(name, profiles);
      if (speaker === null) return;
      const base64 = await queryClient
        .ensureQueryData(villagerFaceQueryOptions(speaker.slug))
        .catch(() => null);
      const face = base64 ? faceUrl(base64) : null;
      // Only a rare one wears their color, on their dialogue box's name
      // plate. A legendary one's letter takes its stationery's.
      const color =
        withColor && face !== null && speaker.rarity === "rare"
          ? await faceColor(face)
          : null;
      speakers.set(id, { ...speaker, face, color });
    }),
  );
  return speakers;
}
