// Renderer-side ClientTransport onto a relay peer (v2 step 4, slice
// C). The single relay socket lives in the main process, so invoke
// forwards through the client-scoped relay bridge and pushes come back
// as one peerPush broadcast the renderer filters by device and
// channel. One underlying bridge subscription serves every device and
// every channel, with local handler sets doing the fan-out, so adding
// a subscriber never adds an IPC listener.
//
// Dial-on-subscribe (v2 step 6, slice B): pushes only reach helloed
// sessions, and a session used to open only on the first invoke, so a
// subscribe-only view received nothing. Subscribing now ensures the
// peer session through the bridge's explicit ensure path, and a
// reconnect re-ensures the session of every device that still has live
// subscribers, so subscriptions survive a relay socket drop.
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import type { ClientTransport } from "@shared/ipc/transport";

type PushHandler = (payload: unknown) => void;

// Keyed by `${deviceId}\n${channel}`. A newline can appear in neither
// half, so the composite key is unambiguous. The shared registry owns
// the add/remove/fan-out and isolates a throwing subscriber, the try
// /catch this copy previously lacked.
const registry = createSubscriberRegistry("relay");
let unsubscribeUnderlying: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

// Live subscriber count per deviceId, so a reconnect re-ensures exactly
// the sessions somebody is listening to and nothing else.
const deviceSubscriberCounts = new Map<string, number>();

function keyFor(deviceId: string, channel: string): string {
  return `${deviceId}\n${channel}`;
}

// Best effort on purpose: an offline peer rejects the ensure, and the
// next statusChanged snapshot that shows the device online retries. A
// live cached session makes this a no-op in main.
function ensurePeerSession(deviceId: string): void {
  void window.api.relay.ensurePeer({ deviceId }).catch(() => {});
}

function ensureUnderlying(): void {
  if (unsubscribeUnderlying === null) {
    unsubscribeUnderlying = window.api.relay.onPeerPush(
      ({ deviceId, channel, payload }) => {
        registry.emit(keyFor(deviceId, channel), payload);
      },
    );
  }
  if (unsubscribeStatus === null) {
    // Peer sessions die with the relay socket (teardown), with the
    // peer's presence, and with the direct socket itself, and main's
    // session cache drops them on close. Re-ensure a subscribed
    // device's session on any connected snapshot where the roster
    // shows it online WITHOUT an established direct session (a
    // peerAppVersions key is what "established" means): that covers a
    // supervisor reconnect, a peer coming back online, and a dropped
    // direct socket alike, since the drop itself broadcasts the
    // snapshot this listener redials from. A steady connected stream
    // re-ensures nothing (every subscribed peer shows established),
    // snapshots only arrive on transitions, and a peer that stays
    // unreachable is bounded by the dialer's failure memo, so this
    // cannot loop.
    unsubscribeStatus = window.api.relay.onStatusChanged((status) => {
      if (status.socket.phase !== "connected") return;
      const online = new Set(status.onlineDeviceIds);
      const direct = new Set(Object.keys(status.peerAppVersions));
      for (const deviceId of deviceSubscriberCounts.keys()) {
        if (online.has(deviceId) && !direct.has(deviceId)) {
          ensurePeerSession(deviceId);
        }
      }
    });
  }
}

function releaseUnderlyingIfIdle(): void {
  if (registry.size() !== 0) return;
  if (unsubscribeUnderlying !== null) {
    unsubscribeUnderlying();
    unsubscribeUnderlying = null;
  }
  if (unsubscribeStatus !== null) {
    unsubscribeStatus();
    unsubscribeStatus = null;
  }
}

// A ClientTransport bound to one relay peer. Handed to buildApi as the
// host transport, exactly where the LAN path hands its socket
// transport, so everything above stays transport agnostic.
export function createRelayClientTransport(deviceId: string): ClientTransport {
  return {
    invoke(channel: string, input: unknown): Promise<unknown> {
      // Omit input when undefined so a void contract input survives the
      // bridge as an absent field, matching both wires' invariant.
      return window.api.relay.invokePeer(
        input === undefined
          ? { deviceId, channel }
          : { deviceId, channel, input },
      );
    },
    subscribe(channel: string, handler: PushHandler): () => void {
      const unsubscribe = registry.subscribe(
        keyFor(deviceId, channel),
        handler,
      );
      deviceSubscriberCounts.set(
        deviceId,
        (deviceSubscriberCounts.get(deviceId) ?? 0) + 1,
      );
      ensureUnderlying();
      // Subscribing alone opens the peer session, so pushes flow
      // without any prior invoke.
      ensurePeerSession(deviceId);
      let released = false;
      return () => {
        // Idempotent so a double-unsubscribe cannot drive the device
        // count below this subscription's own contribution.
        if (released) return;
        released = true;
        unsubscribe();
        const next = (deviceSubscriberCounts.get(deviceId) ?? 1) - 1;
        if (next <= 0) deviceSubscriberCounts.delete(deviceId);
        else deviceSubscriberCounts.set(deviceId, next);
        releaseUnderlyingIfIdle();
      };
    },
  };
}
