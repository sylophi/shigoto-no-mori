import { clientSetting } from "@shigomori/contracts/schemas/config";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useKeepReachableUpdate } from "@/hooks/config/useKeepReachableUpdate";
import { KeepReachableToggleView } from "@shigomori/ui/views/remote/KeepReachableToggleView.tsx";

// Written immediately through the client store.
export function KeepReachableToggle() {
  const { data: clientConfig } = useClientConfig();
  const keepReachableUpdate = useKeepReachableUpdate();
  return (
    <KeepReachableToggleView
      on={clientSetting(clientConfig ?? {}, "keepReachable")}
      pending={keepReachableUpdate.isPending}
      onChange={(next) => keepReachableUpdate.mutate(next)}
    />
  );
}
