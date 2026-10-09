// This machine's sharing switch, written through the host as it flips.
// Off, the account's other devices see it as not sharing, with nothing
// on it, while the mirrors this machine asks for keep working.
import { useSetSharing, useSharing } from "@/hooks/account/useSharing";
import { ShareDataToggleView } from "./ShareDataToggleView";

export function ShareDataToggle() {
  const { data: on, isError } = useSharing();
  const setSharing = useSetSharing();
  return (
    <ShareDataToggleView
      on={on}
      // Inert until the first read lands, like the control switch.
      disabled={(on === undefined && !isError) || setSharing.isPending}
      onChange={(next) => setSharing.mutate(next)}
    />
  );
}
