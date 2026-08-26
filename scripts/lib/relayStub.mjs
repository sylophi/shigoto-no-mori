// The stub Durable Object shared by the relay-transport checks: a node
// ws server implementing relayObject.ts's envelope behavior (deliver
// forwarding, full-roster presence on join and leave, offline and
// too-large nacks, supersede on a duplicate deviceId). Extracted from
// check-relay-link.mjs so check-sync-transfer.mjs drives the same stub
// instead of a second copy. Runs under register-ts-alias so the shared
// TypeScript imports resolve.
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_SUPERSEDED,
  decodeEnvelope,
  DeviceEnvelopeSchema,
  encodeEnvelope,
  relayTextWithinLimit,
} from "@shared/relay/protocol";

// Tickets are "t:<deviceId>:<n>". The real DO burns single-use tickets,
// but the app side never depends on that, so the stub just parses the
// deviceId out and accepts.
function deviceIdOfTicket(ticket) {
  const parts = ticket.split(":");
  return parts[0] === "t" && parts[1] ? parts[1] : null;
}

export function startStubRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sockets = new Map();
    // Every device envelope the stub received, parsed, plus counters so
    // a test can assert a frame never hit the wire.
    const received = [];
    let forwarded = 0;

    function broadcastPresence() {
      const online = [...sockets.keys()].toSorted();
      const text = encodeEnvelope({ t: "presence", online });
      for (const ws of sockets.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      }
    }

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const deviceId = deviceIdOfTicket(url.searchParams.get("ticket") ?? "");
      if (deviceId === null) {
        ws.close(4101, "ticket rejected");
        return;
      }
      const superseded = sockets.get(deviceId);
      sockets.set(deviceId, ws);
      if (superseded) {
        superseded.close(CLOSE_SUPERSEDED, "superseded");
      }
      broadcastPresence();
      ws.on("message", (data) => {
        const envelope = decodeEnvelope(
          data.toString("utf8"),
          DeviceEnvelopeSchema,
        );
        if (envelope === null) return;
        received.push({
          from: deviceId,
          to: envelope.to,
          frame: envelope.frame,
        });
        const target = sockets.get(envelope.to);
        if (target === undefined || target.readyState !== WebSocket.OPEN) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "offline" }),
          );
          return;
        }
        const outbound = encodeEnvelope({
          t: "relay",
          from: deviceId,
          frame: envelope.frame,
        });
        if (!relayTextWithinLimit(outbound)) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "too-large" }),
          );
          return;
        }
        forwarded += 1;
        target.send(outbound);
      });
      ws.on("close", () => {
        if (sockets.get(deviceId) === ws) {
          sockets.delete(deviceId);
          broadcastPresence();
        }
      });
    });

    wss.on("listening", () => {
      const { port } = wss.address();
      resolve({
        port,
        relayUrl: `http://127.0.0.1:${port}`,
        received,
        receivedCount: () => received.length,
        forwardedCount: () => forwarded,
        // Count device->DO sends whose sender was the named device, for
        // asserting a device stayed silent (offline gate, post-stop).
        sendsFrom: (deviceId) =>
          received.filter((entry) => entry.from === deviceId).length,
        // Whether the named sender ever addressed a send to `to`.
        sentTo: (from, to) =>
          received.some((entry) => entry.from === from && entry.to === to),
        // Push an arbitrary server message (a forged deliver, or raw
        // text) straight to a connected device, the seam a hostile-relay
        // test drives.
        injectTo(deviceId, envelopeOrText) {
          const ws = sockets.get(deviceId);
          if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            typeof envelopeOrText === "string"
              ? envelopeOrText
              : encodeEnvelope(envelopeOrText),
          );
        },
        // Server-initiated close for one device's socket, the seam the
        // revoked/superseded/reconnect tests drive.
        dropSocket(deviceId, code, reason = "") {
          const ws = sockets.get(deviceId);
          if (ws) ws.close(code, reason);
        },
        close: () =>
          new Promise((done) => {
            for (const ws of sockets.values()) ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
