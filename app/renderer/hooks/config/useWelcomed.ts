// Whether this install is past its first run (ClientConfig.welcomed),
// and the write that says so, made once.
import { useClientConfig } from "./useClientConfig";
import { useClientConfigPatch } from "./useClientConfigPatch";

export function useMarkWelcomed(): () => void {
  const { data: config } = useClientConfig();
  const { mutate } = useClientConfigPatch(
    () => ({ welcomed: true }),
    "Couldn't save the first run",
  );
  return () => {
    if (config !== undefined && config.welcomed !== true) mutate(undefined);
  };
}
