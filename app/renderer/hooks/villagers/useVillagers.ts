import { queryOptions, useQuery } from "@tanstack/react-query";
import type { VillagerProfiles } from "@shared/schemas";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { type HostReadScope, useHostScope } from "@/hooks/remote/useHostScope";

// The villager extras' data, read from the device the surrounding
// HostScope names and only while useVillageLife() says the extras show.
// Neither changes once downloaded, so both are read once.

// A villager's face as a data URL, or null: no face for that name (or
// no name), or no extras on that device.
export function useVillagerFace(slug: string | null): string | null {
  const shown = useVillageLife();
  const { data } = useQuery({
    ...villagerFaceQueryOptions(useHostScope(), slug ?? ""),
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
    ...villagerProfilesQueryOptions(useHostScope()),
    enabled: shown,
  });
  return shown ? (data ?? undefined) : undefined;
}

// The reads themselves, shared with callers outside React (the villager
// toasts, lib/villagers/speakers.ts), so both use one cache entry.
export function villagerFaceQueryOptions(scope: HostReadScope, slug: string) {
  return queryOptions({
    queryKey: scope.keys.villagerFace(slug),
    queryFn: () => scope.api.villagers.face(slug),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentError: true },
  });
}

export function villagerProfilesQueryOptions(scope: HostReadScope) {
  return queryOptions({
    queryKey: scope.keys.villagerProfiles(),
    queryFn: () => scope.api.villagers.profiles(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentError: true },
  });
}

export function faceUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}
