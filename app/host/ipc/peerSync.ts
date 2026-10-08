// The one seam every reach into a peer device goes through: a client
// for any contract on the peer's direct session, the byte channels of
// that session, and this device's own id. main injects it at boot
// (main/ipc/handlers.ts), since the remote plumbing lives there, and
// its transport must route through the bridge's SHARED direct-session
// cache (makeHubHandlers), never a fresh dial: the host keeps exactly
// one authed socket per deviceId, and a second dial silently supersedes
// the session every remote-forest query is riding on.
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { ChannelMux } from "@shared/ipc/socket/channels";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { buildClient } from "@shared/ipc/buildClient";
import type { ClientTransport } from "@shared/ipc/transport";
import { implSlot } from "@host/lib/util/implSlot";
import type { ContractModule } from "@shigomori/contracts/contract";
import type { Client } from "@shigomori/contracts/types";
import { type Worktree } from "@shigomori/contracts/schemas";

// The remote verbs the orchestrations drive, and the byte channels of
// the same cached session that their source links ride
// (host/lib/sync/sourceLink.ts): resolving once the direct session
// exists, rejecting when there is none.
export type PeerChannels = () => Promise<Pick<ChannelMux, "attach" | "has">>;
export type PeerSyncApi = Pick<
  Client<typeof syncContract>,
  | "ignoredPaths"
  | "hasCommits"
  | "openSource"
  | "receiveWorktree"
  | "receiveBundle"
  | "cancelMove"
  // The progress a start the peer runs for this device streams back
  // (mirror:startFrom relays it to its caller).
  | "onPullProgress"
> & { channels: PeerChannels };

// The reach into a peer's mirror surface: the git follower's (read the
// git state of a served worktree and apply one there) and the mirror
// start asked from the copy's side (the peer's startTo, with this
// device as the target, mirror:startFrom), and the word that a copy
// there is no longer mirrored (mirror:release).
export type PeerMirrorApi = Pick<
  Client<typeof mirrorContract>,
  "gitState" | "applyGitState" | "startTo" | "release"
>;

// The transplant orchestration's teardown reach (the peer's ordinary
// worktrees:delete), the mirror start's path lookup (worktrees:list)
// and the control ops' shelving of a brought worktree's source, riding
// the same grant-gated wire as the sync verbs.
export type PeerWorktreesApi = Pick<
  Client<typeof worktreesContract>,
  "delete" | "list" | "setShelved"
>;

// A worktree's title and description, read off the source and written
// onto the copy (host/lib/sync/worktreeDescription.ts).
export type PeerWorktreeDataApi = Pick<
  Client<typeof worktreeDataContract>,
  "read" | "describe"
>;

type PeerReach = {
  transportFor: (deviceId: string) => ClientTransport;
  channelsFor: (deviceId: string) => PeerChannels;
  // This device's own id, the target a mirror asked for from here
  // names to the peer.
  thisDeviceId: () => string;
};

const { set: setPeerReach, get: requireReach } = implSlot<PeerReach>(
  "peer reach requested before setPeerReach ran",
);
export { setPeerReach };

// A peer's surface for one contract, on the cached direct session:
// built per call, never held.
export function peerClient<M extends ContractModule>(
  contract: M,
  deviceId: string,
): Client<M> {
  return buildClient(contract, requireReach().transportFor(deviceId));
}

export function peerSyncApiFor(deviceId: string): PeerSyncApi {
  return {
    ...peerClient(syncContract, deviceId),
    channels: requireReach().channelsFor(deviceId),
  };
}

export function peerWorktreesApiFor(deviceId: string): PeerWorktreesApi {
  return peerClient(worktreesContract, deviceId);
}

export function peerMirrorApiFor(deviceId: string): PeerMirrorApi {
  return peerClient(mirrorContract, deviceId);
}

export function peerWorktreeDataApiFor(deviceId: string): PeerWorktreeDataApi {
  return peerClient(worktreeDataContract, deviceId);
}

export function thisDeviceId(): string {
  return requireReach().thisDeviceId();
}

// One of a peer's worktrees, read off its own list (which the peer's
// client decoded): its root path flows into a session this device
// persists, so the caller's say-so is never the source of it.
// undefined when the peer no longer lists it.
export async function peerWorktreeOrUndefined(
  deviceId: string,
  projectId: string,
  worktreeId: string,
): Promise<Worktree | undefined> {
  const worktrees = await peerWorktreesApiFor(deviceId).list({ projectId });
  return worktrees.find((worktree) => worktree.id === worktreeId);
}
