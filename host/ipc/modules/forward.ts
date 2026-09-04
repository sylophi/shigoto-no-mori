// Host side of the byte-stream opens (shared/ipc/modules/forward.ts):
// a granted peer names a channel id it has already attached on its
// end, and this host attaches the far end under that id on the
// calling connection: a loopback TCP dial (a port forward) or a fresh
// `file-sync serve` child's stdio (a worktree mirror stream,
// file-sync/engine.go). From then on the bytes ride the channel
// (shared/ipc/socket/channels.ts) with credit-based backpressure, and
// the far end lives exactly as long as the channel: a peer reset, a
// clean end from both sides, or the socket dying tears it down. No
// registry, no idle sweep, nothing to leak past the connection.
import type { Socket } from "node:net";
import { errorMessageOf } from "@shared/errors";
import {
  FORWARD_CHANNEL_TAKEN,
  FORWARD_CONNECT_FAILED,
  FORWARD_NO_CHANNELS,
  FORWARD_TOO_MANY_CONNS,
  forwardContract,
} from "@shared/ipc/modules/forward";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { MirrorServing } from "@shared/ipc/modules/mirror";
import { dialLoopback } from "@host/lib/net";
import { spawnFileSync } from "@host/fileSync/spawn";
import { watchIndexFile } from "@host/mirror/gitState";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import { findProjectOrThrow } from "@host/lib/projects";
import { bridgeDuplexToChannel } from "@host/socket/channelStreams";

// Grant-gated already (a trusted peer), so the cap is a sanity bound
// against a runaway client loop, not a quota. Per connection: sized
// for a real page load through a forward (a browser tab opens ~6
// keepalive sockets plus an HMR websocket) beside a few mirror
// streams.
const MAX_CHANNELS_PER_PEER = 32;
// How long a dial may sit unanswered before the open refuses.
const DIAL_TIMEOUT_MS = 5_000;

// The mirror streams this host currently serves, keyed by channel id:
// what mirror:list reports as `serving`, so a worktree shows "mirrored
// to <device>" on the machine it lives on. Entries live exactly as
// long as their channel.
const serving = new Map<string, MirrorServing>();
// The served worktree's index watcher, alive exactly as long as the
// stream: a stage or unstage there is the one git change the peer's
// follower cannot learn from the git-directory watcher.
const servingIndexWatch = new Map<string, () => void>();
let onServingChange: (() => void) | null = null;
let onServingGitChange:
  | ((change: { projectId: string; worktreeId: string }) => void)
  | null = null;

// The mirror handler module installs the changed-broadcast hooks here
// at boot; before that (and in checks that never mount them) changes
// are simply unannounced.
export function setMirrorServingListener(listener: (() => void) | null): void {
  onServingChange = listener;
}

export function setMirrorGitChangedListener(
  listener:
    | ((change: { projectId: string; worktreeId: string }) => void)
    | null,
): void {
  onServingGitChange = listener;
}

export function listMirrorServing(): MirrorServing[] {
  return [...serving.values()];
}

function forgetServing(channelId: string): void {
  servingIndexWatch.get(channelId)?.();
  servingIndexWatch.delete(channelId);
  if (serving.delete(channelId)) onServingChange?.();
}

// The connection's channel capability, or the coded refusal for a wire
// without one (a loopback, the Electron bridge). The id must be free
// on that connection and the cap must hold.
function channelsOf(ctx: HandlerContext, channelId: string) {
  const channels = ctx.channels;
  if (channels === undefined) throw new Error(FORWARD_NO_CHANNELS);
  if (channels.has(channelId)) throw new Error(FORWARD_CHANNEL_TAKEN);
  if (channels.size() >= MAX_CHANNELS_PER_PEER) {
    throw new Error(FORWARD_TOO_MANY_CONNS);
  }
  return channels;
}

// Error messages below are stable markers, not prose (the FORWARD_*
// constants beside the contract): Electron IPC and the device wires
// both preserve only the message string, so the client side and the
// UI match these exact texts.

export const forwardHandlers: Handlers<typeof forwardContract, HandlerContext> =
  {
    open: async ({ port, channelId }, ctx) => {
      // The schema already pinned the range. Re-check so this handler
      // stays fail-closed even if it is ever reached off-contract.
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${FORWARD_CONNECT_FAILED}: port out of range`);
      }
      const channels = channelsOf(ctx, channelId);
      // Loopback only, always: the feature is reaching the host's OWN
      // dev server, never using the host as a hop to its network. The
      // shared dial (host/lib/net.ts) tries 127.0.0.1 then ::1 and
      // carries its own deadline, so a hung dial cannot burn one of
      // the peer's in-flight slots forever.
      let socket: Socket;
      try {
        socket = await dialLoopback(port, DIAL_TIMEOUT_MS);
      } catch (error) {
        throw new Error(`${FORWARD_CONNECT_FAILED}: ${errorMessageOf(error)}`, {
          cause: error,
        });
      }
      // The dial spanned an await: the connection may have died or the
      // id may have been claimed meanwhile.
      if (channels.has(channelId) || ctx.signal.aborted) {
        socket.destroy();
        throw new Error(FORWARD_CHANNEL_TAKEN);
      }
      // Nagle batches small writes against the wire's round trips, so
      // keystrokes and small frames must not wait on it.
      socket.setNoDelay(true);
      bridgeDuplexToChannel(socket, (endpoint) =>
        channels.attach(channelId, endpoint),
      );
    },

    // A mirror stream: the far end is a fresh `file-sync serve` for the
    // named worktree, spoken to over its stdio. The worktree must exist
    // in this host's registry (a peer can only mirror what this device
    // lists), and the child dies with the channel: a peer reset, an
    // end from both sides or the socket dying all kill it, and a child
    // that exits on its own ends the channel the ordinary way. The
    // root path the peer's Mutagen side names travels inside the
    // protocol, which this handler does not read: the grant is the
    // wall, as everywhere on this surface.
    openMirror: async ({ projectId, worktreeId, channelId }, ctx) => {
      const project = findProjectOrThrow(projectId);
      const identity = await findWorktreeIdentityOrThrow(
        projectId,
        project.path,
        worktreeId,
      );
      const channels = channelsOf(ctx, channelId);
      const child = spawnFileSync(["serve"]);
      if (child === null) {
        throw new Error(
          "mirroring is unavailable on this device (no file-sync engine)",
        );
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text !== "") console.warn(`[mirror] serve ${worktreeId}: ${text}`);
      });
      bridgeDuplexToChannel(
        child.stream,
        (endpoint) => channels.attach(channelId, endpoint),
        {
          onClosed: () => {
            child.kill();
            child.stream.destroy();
            forgetServing(channelId);
          },
        },
      );
      serving.set(channelId, {
        connId: channelId,
        projectId,
        worktreeId,
        peerDeviceId: ctx.callerDeviceId ?? "",
        since: Date.now(),
      });
      void watchIndexFile(identity.path, () =>
        onServingGitChange?.({ projectId, worktreeId }),
      ).then(
        (stop) => {
          if (serving.has(channelId)) servingIndexWatch.set(channelId, stop);
          else stop();
        },
        () => {},
      );
      onServingChange?.();
    },
  };
