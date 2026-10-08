import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useTerrierReadiness } from "./useTerrierReadiness";

// Whether the scoped device lists terrier's repos as projects, and so
// whether the add-project dialog offers to register new ones there too.
// Off while terrier can't be read, as the CLI's merge is.
export function useOffersTerrier(): boolean {
  const { data: config } = useGlobalConfig();
  const on = config?.terrier === true;
  // Asked only of a device with the toggle on: an off one never offers.
  const { data: readiness } = useTerrierReadiness({ enabled: on });
  return on && readiness?.readable === true;
}
