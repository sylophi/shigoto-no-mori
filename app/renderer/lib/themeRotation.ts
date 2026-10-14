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

// The cache takes the turn before the write lands, so the launch's
// render waits on a read alone.
async function turn(queryClient: QueryClient, launching: boolean) {
  const config = await queryClient.fetchQuery(clientConfigQueryOptions);
  const patch = rotationTurn(config, Date.now(), launching);
  if (!patch) return;
  queryClient.setQueryData<ClientConfig>(queryKeys.clientConfig(), {
    ...config,
    ...patch,
  });
  void mergeClientConfigWrite(queryClient, patch).catch(warn);
}

export async function startThemeRotation(
  queryClient: QueryClient,
): Promise<void> {
  setInterval(() => void turn(queryClient, false).catch(warn), CHECK_MS);
  await turn(queryClient, true).catch(warn);
}
