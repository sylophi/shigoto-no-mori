import { queryOptions, useQuery } from "@tanstack/react-query";
import type { VillagerProfiles } from "@shigomori/contracts/schemas";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { queryKeysFor } from "@/lib/queryKeys";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";

// The villager extras' data, read from this device's copy
// (host/lib/VillagerData.ts) and only while useVillageLife() says the
// extras show, whichever device a worktree lives on. Neither changes
// once downloaded, so both are read once.

// A villager's face as a data URL, or null: no face for that name (or
// no name), or no extras in this window.
export function useVillagerFace(slug: string | null): string | null {
  const shown = useVillageLife();
  const { data } = useQuery({
    ...villagerFaceQueryOptions(useApi(), slug ?? ""),
    enabled: shown && slug !== null,
  });
  return shown && slug !== null && data ? faceUrl(data) : null;
}

// Every villager's profile (name, species, personality, birthday,
// catchphrase and the rest, as far as the wiki has them), by slug, or
// undefined while the extras don't show.
export function useVillagerProfiles(): VillagerProfiles | undefined {
  const shown = useVillageLife();
  const { data } = useQuery({
    ...villagerProfilesQueryOptions(useApi()),
    enabled: shown,
  });
  return shown ? (data ?? undefined) : undefined;
}

// The reads themselves, shared with callers outside React (the villager
// toasts, lib/villagers/speakers.ts), so both use one cache entry.
export function villagerFaceQueryOptions(api: RendererApi, slug: string) {
  return queryOptions({
    queryKey: queryKeysFor(api.deviceId).villagerFace(slug),
    queryFn: ({ signal }) => api.run(api.villagers.face({ slug }), { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentError: true },
  });
}

export function villagerProfilesQueryOptions(api: RendererApi) {
  return queryOptions({
    queryKey: queryKeysFor(api.deviceId).villagerProfiles(),
    queryFn: ({ signal }) => api.run(api.villagers.profiles(), { signal }),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentError: true },
  });
}

export function faceUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}
