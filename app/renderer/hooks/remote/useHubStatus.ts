import { useAtomValue } from "@effect/atom-react";
import type { HubStatus, TunnelState } from "@shigomori/contracts/modules/hub";
import * as Atom from "effect/reactivity/Atom";
import { hubStatusAtom, hubStatusOf } from "@/lib/remote/remoteDeviceSync";

// The hub bridge's live status (hubStatusAtom, which the device sync
// mounts for the page's life), null until the first snapshot lands.
export function useHubStatus(): HubStatus | null {
  return useAtomValue(hubStatusAtom, hubStatusOf);
}

// For readers that only care about THIS device's tunnel endpoint (the
// marker and the note on the this-device row): a selector, so roster
// and socket transitions leave those components alone. Undefined until
// the first snapshot lands, and on a platform with no host half (the
// web bridge runs no cloudflared).
export function useTunnelState(): TunnelState | undefined {
  return useAtomValue(hubStatusAtom, (result) => hubStatusOf(result)?.tunnel);
}

// THIS device's blocked socket, or null while it is anything else (the
// account sync's sign-out trigger, the registry's blocked banner).
// Every snapshot arrives as a fresh object, so the atom keeps the
// previous value while the two fields it reads are unchanged, which is
// what keeps roster and presence traffic from re-rendering the readers.
type HubBlock = Extract<HubStatus["socket"], { phase: "blocked" }>;

const hubBlockAtom = Atom.readable((get): HubBlock | null => {
  const socket = hubStatusOf(get(hubStatusAtom))?.socket;
  return socket?.phase === "blocked" ? socket : null;
}).pipe(
  Atom.withEquality(
    (last: HubBlock | null, next: HubBlock | null) =>
      last === next ||
      (last !== null &&
        next !== null &&
        last.reason === next.reason &&
        last.message === next.message),
  ),
);

export function useHubBlock(): HubBlock | null {
  return useAtomValue(hubBlockAtom);
}
