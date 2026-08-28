// The pull orchestration's reach into a peer device's sync surface,
// injected at boot following the setCliRunnerImpl precedent: the
// remote plumbing lives in main/, so this seam owns the api shape and
// the sync handlers stay free of Electron imports. The injected
// factory must route through the bridge's SHARED direct-session cache
// (makeRelayHandlers), never a fresh dial: the host keeps exactly one
// authed socket per deviceId, and a second dial silently supersedes
// the session every remote-forest query is riding on.
import type { syncContract } from "@shared/ipc/modules/sync";
import type { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { Client } from "@shared/ipc/types";

// The remote verbs the orchestration drives. Superset of the transfer
// slice fetchBundleFromPeer takes, so one client serves both.
export type PeerSyncApi = Pick<
  Client<typeof syncContract>,
  "refTips" | "captureDirty" | "bundleStart" | "bundleChunk" | "bundleAbort"
>;

// The transplant orchestration's teardown reach: the peer's ordinary
// worktrees:delete, riding the same grant-gated wire as the sync verbs.
export type PeerWorktreesApi = Pick<Client<typeof worktreesContract>, "delete">;

type PeerSyncImpl = {
  syncApiFor: (deviceId: string) => PeerSyncApi;
  worktreesApiFor: (deviceId: string) => PeerWorktreesApi;
};

let impl: PeerSyncImpl | null = null;

export function setPeerSyncApiImpl(next: PeerSyncImpl): void {
  impl = next;
}

function requireImpl(): PeerSyncImpl {
  if (impl === null) {
    throw new Error("peer api requested before setPeerSyncApiImpl ran");
  }
  return impl;
}

export function peerSyncApiFor(deviceId: string): PeerSyncApi {
  return requireImpl().syncApiFor(deviceId);
}

export function peerWorktreesApiFor(deviceId: string): PeerWorktreesApi {
  return requireImpl().worktreesApiFor(deviceId);
}
