import { useQuery } from "@tanstack/react-query";
import type { VillagerProfiles } from "@shared/schemas";
import { useVillageLife } from "@/hooks/config/useVillageLife";
import { useHostScope } from "@/hooks/remote/useHostScope";

// The villager extras' data, read from the device the surrounding
// HostScope names and only while useVillageLife() says the extras show.
// Neither changes once downloaded, so both are read once.

// A villager's face as a data URL, or null: no face for that name, or
// no extras on that device.
export function useVillagerFace(slug: string): string | null {
  const shown = useVillageLife();
  const { api, keys } = useHostScope();
  const { data } = useQuery({
    queryKey: keys.villagerFace(slug),
    queryFn: () => api.villagers.face(slug),
    enabled: shown,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentError: true },
  });
  return shown && data ? `data:image/png;base64,${data}` : null;
}

// Every villager's profile (name, species, personality, birthday,
// catchphrase and the rest, as far as the wiki has them), by slug, or
// undefined while the extras don't show.
export function useVillagerProfiles(): VillagerProfiles | undefined {
  const shown = useVillageLife();
  const { api, keys } = useHostScope();
  const { data } = useQuery({
    queryKey: keys.villagerProfiles(),
    queryFn: () => api.villagers.profiles(),
    enabled: shown,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentError: true },
  });
  return shown ? (data ?? undefined) : undefined;
}
