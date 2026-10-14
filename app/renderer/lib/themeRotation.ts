// The palette rotation (Settings > Appearance, shared/themes.ts
// rotationTurn): a turn at launch, before the first render so the
// window opens in the new palette, then a check each minute for the
// timed ones. A turn saves the picks the way Settings would, so the
// next launch's boot mirror paints them.
import type { QueryClient } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { rotationTurn } from "@shared/themes";
import { clientConfigQueryOptions } from "@/hooks/config/useClientConfig";
import { mergeClientConfigWrite } from "@/hooks/config/mergeClientConfigWrite";
import { queryKeys } from "@/lib/queryKeys";

const CHECK_MS = 60 * 1000;

const warn = (error: unknown) => console.warn("[themeRotation]", error);

// Settings holds the rotation while it is open: its form seeds the
// picks once, so a save after a turn would put back the pair the turn
// moved on from.
let holds = 0;
export function holdThemeRotation(): () => void {
  holds += 1;
  return () => {
    holds -= 1;
  };
}

async function turn(queryClient: QueryClient, launching: boolean) {
  if (holds > 0) return;
  // The cached doc rules a check out without a read. A turn it finds
  // due rereads the store, which another tab (a web client's) may have
  // moved on since. A failed read lets the launch render at once, and
  // warns below rather than toasting every minute.
  const cached = queryClient.getQueryData<ClientConfig>(
    queryKeys.clientConfig(),
  );
  if (!launching && !(cached && rotationTurn(cached, Date.now(), false))) {
    return;
  }
  const config = await queryClient.fetchQuery({
    ...clientConfigQueryOptions,
    staleTime: 0,
    retry: false,
    meta: { silentError: true },
  });
  const patch = rotationTurn(config, Date.now(), launching);
  if (!patch) return;
  // The cache takes the turn before the write lands, so the launch's
  // render waits on the read alone. A refetch in flight would land
  // over it, and a failed write takes it back.
  await queryClient.cancelQueries({ queryKey: queryKeys.clientConfig() });
  queryClient.setQueryData<ClientConfig>(queryKeys.clientConfig(), {
    ...config,
    ...patch,
  });
  void mergeClientConfigWrite(queryClient, patch).catch((error: unknown) => {
    warn(error);
    queryClient.setQueryData(queryKeys.clientConfig(), config);
  });
}

export async function startThemeRotation(
  queryClient: QueryClient,
): Promise<void> {
  setInterval(() => void turn(queryClient, false).catch(warn), CHECK_MS);
  await turn(queryClient, true).catch(warn);
}
