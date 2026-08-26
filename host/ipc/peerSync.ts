// The pull orchestration's reach into a peer device's sync surface,
// injected at boot following the setCliRunnerImpl precedent: the relay
// plumbing lives in main/, so this seam owns the api shape and the
// sync handlers stay free of Electron imports. The injected factory
// must route through the relay bridge's SHARED peer-session cache
// (makeRelayHandlers), never a fresh connectPeer: the link keeps
// exactly one client peer per deviceId, and a second dial silently
// destroys the session every remote-forest query is riding on.
import type { syncContract } from "@shared/ipc/modules/sync";
import type { Client } from "@shared/ipc/types";

// The remote verbs the orchestration drives. Superset of
// fetchBundleFromPeer's PeerSyncApi, so one client serves both.
export type PeerSyncApi = Pick<
  Client<typeof syncContract>,
  "refTips" | "captureDirty" | "bundleStart" | "bundleChunk" | "bundleAbort"
>;

type PeerSyncImpl = {
  syncApiFor: (deviceId: string) => PeerSyncApi;
};

let impl: PeerSyncImpl | null = null;

export function setPeerSyncApiImpl(next: PeerSyncImpl): void {
  impl = next;
}

export function peerSyncApiFor(deviceId: string): PeerSyncApi {
  if (impl === null) {
    throw new Error("peer sync api requested before setPeerSyncApiImpl ran");
  }
  return impl.syncApiFor(deviceId);
}
