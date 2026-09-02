// Renderer-side ClientTransport onto a hub peer (v2 step 4, slice
// C). The single hub socket lives in the main process, so invoke
// forwards through the client-scoped hub bridge and pushes come back
// as one peerPush broadcast the renderer filters by device and
// channel. One underlying bridge subscription serves every device and
// every channel, with local handler sets doing the fan-out, so adding
// a subscriber never adds an IPC listener.
//
// Deliberately passive about sessions (v2 step 11): direct peer
// sessions are supervised desired state owned by main's keeper
// (shared/hub/directKeeper.ts), which dials every rostered peer
// eagerly and redials forever. Subscribing here therefore only
// registers the local handler -- the session a push needs either
// already exists or is the keeper's job, and the dial-on-subscribe
// ensure plus reconnect re-ensure loop this file used to run would be
// a second retry driver fighting the keeper's ladder.
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import type { ClientTransport } from "@shared/ipc/transport";

type PushHandler = (payload: unknown) => void;

// Keyed by `${deviceId}\n${channel}`. A newline can appear in neither
// half, so the composite key is unambiguous. The shared registry owns
// the add/remove/fan-out and isolates a throwing subscriber.
const registry = createSubscriberRegistry("hub");
let unsubscribeUnderlying: (() => void) | null = null;

function keyFor(deviceId: string, channel: string): string {
  return `${deviceId}\n${channel}`;
}

function ensureUnderlying(): void {
  if (unsubscribeUnderlying === null) {
    unsubscribeUnderlying = window.api.hub.onPeerPush(
      ({ deviceId, channel, payload }) => {
        registry.emit(keyFor(deviceId, channel), payload);
      },
    );
  }
}

function releaseUnderlyingIfIdle(): void {
  if (registry.size() !== 0) return;
  if (unsubscribeUnderlying !== null) {
    unsubscribeUnderlying();
    unsubscribeUnderlying = null;
  }
}

// A ClientTransport bound to one hub peer. Handed to buildApi as the
// host transport, exactly where the LAN path hands its socket
// transport, so everything above stays transport agnostic.
export function createHubClientTransport(deviceId: string): ClientTransport {
  return {
    invoke(channel: string, input: unknown): Promise<unknown> {
      // Omit input when undefined so a void contract input survives the
      // bridge as an absent field, matching both wires' invariant.
      return window.api.hub.invokePeer(
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
      ensureUnderlying();
      return () => {
        unsubscribe();
        releaseUnderlyingIfIdle();
      };
    },
  };
}
