// The one place the "carry every out-of-band client key or lose it"
// invariant lives. clientConfig.write is a whole-document write with
// omit-on-default semantics (main/electron/clientConfig.ts clears every
// modeled key, then re-adds the present ones), so a write MUST carry the
// full client config or it wipes the keys it omits. Both callers, the
// appearance Save (useSettingsSave) and the keepReachable toggle
// (useKeepReachableUpdate), only know their own keys, so each goes
// through here: read the live cached doc (the persisted one, since the
// client store has a single writer per key and useClientConfig holds it
// with staleTime Infinity), merge the caller's partial patch over it, and
// write the full result. Returns the merged doc so the caller can set it
// back into the cache. An undefined patch value omits its key, matching
// the store's omit-on-default serialization.
import type { QueryClient } from "@tanstack/react-query";
import type { ClientConfig } from "@shared/schemas";
import { queryKeys } from "@/lib/queryKeys";

export async function mergeClientConfigWrite(
  queryClient: QueryClient,
  patch: Partial<ClientConfig>,
): Promise<ClientConfig> {
  const current =
    queryClient.getQueryData<ClientConfig>(queryKeys.clientConfig()) ?? {};
  const config: ClientConfig = { ...current, ...patch };
  await window.api.clientConfig.write(config);
  return config;
}
