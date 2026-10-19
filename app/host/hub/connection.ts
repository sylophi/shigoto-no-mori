// The node hub connection: the shared lifecycle core in
// shared/hub/connection.ts bound to the node `ws` client, owned by the
// host process (host/process/wires.ts), asking peers for their connect
// info and answering theirs. Deliberately not a wire the host's
// modules register on: it answers one question, handed in at creation
// as a function.
//
// This file must stay Electron free (pnpm test host-boundary).
// Everything Electron or account flavored (deviceId, accountId, the
// credential-backed ticket mint) arrives through HubConnectOpts, which
// the host composes.
import { WebSocket } from "ws";
import { HubLinkDownError } from "@shared/hub/link";
import * as Shared from "@shared/hub/connection";
import { MAX_HUB_MESSAGE_BYTES } from "@shigomori/contracts/hubProtocol";
import { toText } from "./rawData";

export type HubConnectionOpts = Omit<Shared.HubConnectionDeps, "openSocket">;

// The node ws half of the shared socket adapter. Everything ws-specific
// lives here: the inbound payload bound, the disabled compression, the
// RawData decode, and the hard terminate the shared core prefers for
// orphan sockets and arms after an owner close.
function openWsSocket(url: string): Shared.HubSocketAdapter {
  // Bound inbound buffering at the DO's own forwarding limit (nothing
  // it sends is larger: relays are measured against it and a full
  // presence roster fits under it), and disable perMessageDeflate so a
  // compression bomb cannot inflate a tiny frame past the limit.
  // An oversize frame past maxPayload closes the socket (1009), so
  // shrinking MAX_HUB_MESSAGE_BYTES means shipping devices that still
  // read the old size before the Worker enforces the new one
  // (hub/README.md).
  const socket = new WebSocket(url, {
    maxPayload: MAX_HUB_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  socket.on("error", () => {
    // ws follows every error with close. The close handler owns the
    // outcome so the reject reason carries the close code.
  });
  return {
    send(text) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new HubLinkDownError();
      }
      socket.send(text);
    },
    close() {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    },
    terminate() {
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
    },
    onMessage(handler) {
      socket.on("message", (data, isBinary) => {
        // The protocol is JSON text. Binary frames are not part of
        // it, so they are dropped.
        if (isBinary) return;
        handler(toText(data));
      });
    },
    onClose(handler) {
      socket.on("close", (code) => handler(code));
    },
    onRefused(handler) {
      // Heard, ws leaves the handshake to its listener: cut here, which
      // closes the socket as an unanswered upgrade does.
      socket.on("unexpected-response", (_request, response) => {
        const seconds = Number(response.headers["retry-after"]);
        handler(
          response.statusCode ?? 0,
          Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
        );
        socket.terminate();
      });
    },
  };
}

// The connection, for the length of the scope it is made in.
// `serveConnectInfo` answers peers' connectInfo asks (wires.ts wires the
// direct listener's). Absent on a dial-only device (the check
// fixtures'), whose link refuses every ask as serving no listener.
export const make = (opts: HubConnectionOpts) =>
  Shared.make({ ...opts, openSocket: openWsSocket });
