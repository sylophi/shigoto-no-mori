// A peer's host over the hub hop: its calls through hub:invokePeer, its
// views through hub:watchPeer and its pushes out of hub:peerPush, on the
// link to the side that holds the peer's session (the shell in a window,
// the tab itself in the web client). Nothing here dials: sessions are
// supervised desired state owned by the direct keeper
// (shared/hub/directKeeper.ts), so a call that lands on no session
// rejects, and a push needs only the session the keeper already holds.
import * as Stream from "effect/Stream";
import type { Link } from "@shared/ipc/transport";

type PeerPush = {
  readonly deviceId: string;
  readonly channel: string;
  readonly payload: unknown;
};

// The input is left out when there is none, so a void contract input
// crosses the bridge as an absent field.
const hop = (deviceId: string, channel: string, input: unknown) =>
  input === undefined ? { deviceId, channel } : { deviceId, channel, input };

export function peerLink(hub: Link, deviceId: string): Link {
  return {
    call: (channel, input, span) =>
      hub.call("hub:invokePeer", hop(deviceId, channel, input), span),
    view: (channel, input) =>
      hub.view("hub:watchPeer", hop(deviceId, channel, input)),
    pushes: (channel) =>
      hub.pushes("hub:peerPush").pipe(
        Stream.filter((push) => {
          const { deviceId: from, channel: on } = push as PeerPush;
          return from === deviceId && on === channel;
        }),
        Stream.map((push) => (push as PeerPush).payload),
      ),
  };
}
