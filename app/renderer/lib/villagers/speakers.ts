import type { QueryClient } from "@tanstack/react-query";
import type { VillagerProfiles } from "@shared/schemas";
import { villageLifeEnabled, villageLifeShows } from "@shared/villageLife";
import { globalConfigQueryOptions } from "@/hooks/config/useGlobalConfig";
import type { HostScope } from "@/hooks/remote/useHostScope";
import { villagerDataStatusQueryOptions } from "@/hooks/villagers/useVillagerData";
import {
  faceUrl,
  villagerFaceQueryOptions,
  villagerProfilesQueryOptions,
} from "@/hooks/villagers/useVillagers";
import { type Speaker, speakerFor } from "@/lib/villagerVoice";
import { faceColor } from "./faceColor";

// Who speaks for which worktrees on one device, for a toast fired
// outside render. Same gate as useVillageLife, read from the device the
// worktrees live on (its settings and its villager data), through the
// same cache entries the hooks use, so a toast rarely waits on a read.

// The device's villager profiles while its Village life shows, or null.
async function villageOf(
  queryClient: QueryClient,
  scope: HostScope,
): Promise<VillagerProfiles | null> {
  if (!scope.hasHost) return null;
  // No retries: a read that fails leaves the toast plain, now, rather
  // than seconds late.
  const config = await queryClient.ensureQueryData({
    ...globalConfigQueryOptions(scope),
    retry: false,
  });
  if (!villageLifeEnabled(config)) return null;
  const status = await queryClient.ensureQueryData({
    ...villagerDataStatusQueryOptions(scope),
    retry: false,
  });
  if (!villageLifeShows(config, status)) return null;
  return queryClient.ensureQueryData({
    ...villagerProfilesQueryOptions(scope),
    retry: false,
  });
}

// The speaker for each worktree named after a character, by worktree
// id. Empty when the device's Village life doesn't show, or when a read
// fails: a toast then stays plain rather than not showing. `withColor`
// reads a rare one's color off their face, for their dialogue box.
export async function speakersFor(
  queryClient: QueryClient,
  scope: HostScope,
  worktrees: readonly { id: string; name: string }[],
  { withColor = false }: { withColor?: boolean } = {},
): Promise<Map<string, Speaker>> {
  const speakers = new Map<string, Speaker>();
  const profiles = await villageOf(queryClient, scope).catch(() => null);
  if (profiles === null) return speakers;
  await Promise.all(
    worktrees.map(async ({ id, name }) => {
      const speaker = speakerFor(name, profiles);
      if (speaker === null) return;
      const base64 = await queryClient
        .ensureQueryData(villagerFaceQueryOptions(scope, speaker.slug))
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
