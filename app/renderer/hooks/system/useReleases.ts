import { useQuery } from "@tanstack/react-query";
import { errorMessageOf } from "@shared/errors";
import { RATE_LIMITED } from "@shared/releases";
import type { Release } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

// The app's GitHub releases, fetched when a changelog opens. GitHub
// allows 60 unauthenticated calls an hour per address (shared with
// the CLI's update checks), and a release lands a few times a day at
// most, so an answer is kept and stays fresh for half an hour between
// dialogs, and a focus doesn't ask again. A refusal for the rate limit
// won't lift within a retry's backoff, so only other failures retry.
// The dialog shows a failure itself.
const HALF_HOUR_MS = 30 * 60 * 1000;

export function useReleases() {
  return useQuery<readonly Release[]>({
    queryKey: queryKeys.releases(),
    queryFn: () => window.api.releases.list(),
    staleTime: HALF_HOUR_MS,
    gcTime: HALF_HOUR_MS,
    retry: (failures, error) =>
      failures < 3 && errorMessageOf(error) !== RATE_LIMITED,
    refetchOnWindowFocus: false,
    meta: { silentError: true },
  });
}
