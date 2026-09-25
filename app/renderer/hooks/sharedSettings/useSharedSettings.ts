// The shared settings as this device holds them: one document, the
// same on every device once they have talked
// (lib/remote/sharedSettingsSync.ts keeps it level and owns the write
// path). The read never refetches, because the local copy's every move
// arrives on its broadcast and is merged into the cache there.
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SharedSettingsDoc, SharedSettingValue } from "@shared/schemas";
import { sharedStringSetting } from "@shared/sharedSettings";
import { queryKeys } from "@/lib/queryKeys";
import { writeSharedSetting } from "@/lib/remote/sharedSettingsSync";

// The one read every observer shares.
const sharedSettingsQuery = {
  queryKey: queryKeys.sharedSettings(),
  queryFn: () => window.api.sharedSettings.read(),
  // Every move of the local copy arrives on its broadcast, which the
  // sync module merges into this entry.
  staleTime: Number.POSITIVE_INFINITY,
  meta: { errorTitle: "Couldn't load shared settings" },
};

// One string setting out of the document (undefined key: no setting to
// read). Narrowed with `select`, so an observer re-renders when its own
// setting moves and not on every pick made anywhere: the sidebar holds
// one of these per project row, and the document moves on peer traffic.
export function useSharedStringSetting(
  key: string | undefined,
): string | undefined {
  const { data } = useQuery<SharedSettingsDoc, Error, string | null>({
    ...sharedSettingsQuery,
    select: (doc) =>
      key === undefined ? null : (sharedStringSetting(doc, key) ?? null),
  });
  return data ?? undefined;
}

// Whether the local copy has been read (or the read has failed, which
// leaves nothing to wait for). Until then an unset setting and an
// unread one look alike, and a surface that acts on the difference
// holds off.
export function useSharedSettingsSettled(): boolean {
  const { isPending } = useQuery<SharedSettingsDoc, Error, null>({
    ...sharedSettingsQuery,
    select: () => null,
  });
  return !isPending;
}

// The writer for one key (undefined: nothing to write to, a no-op).
// Applies right away. The cache is not set from here: the local copy's
// own broadcast is its one writer, and it lands before this resolves.
export function useSetSharedSetting(
  key: string | undefined,
  errorTitle: string,
) {
  const mutation = useMutation({
    mutationFn: (write: { key: string; value: SharedSettingValue }) =>
      writeSharedSetting(write.key, write.value),
    meta: { errorTitle },
  });
  return (value: SharedSettingValue) => {
    if (key !== undefined) mutation.mutate({ key, value });
  };
}
