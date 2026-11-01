// The stub Durable Object the proofs' devices meet at: a node ws
// server implementing hubObject.ts's envelope behavior (deliver
// forwarding to every socket of a device, full-roster presence on join
// and leave, offline nacks, and supersede: a desktop device's second
// socket, or a connection dialing again).
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_SUPERSEDED,
  decodeEnvelope,
  DeviceEnvelopeSchema,
  deliveredRelay,
  encodeEnvelope,
  HUB_PING,
  HUB_PONG,
} from "@shigomori/contracts/hubProtocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { toText } from "@host/hub/rawData";
import { toBase64Url } from "@shared/crypto/deviceKey";
import { type KeyPair, keyPairFromPrivateKey } from "@shared/crypto/noise";
import { boundPort, type Track } from "./checkKit.mts";

// The key a test device enrolled with, the same for its id in every
// file: the stub's roster names it, and a booted or raw device seals
// with it.
export function testDeviceKey(deviceId: string): {
  pair: KeyPair;
  privateKey: string;
  publicKey: string;
} {
  const pair = keyPairFromPrivateKey(
    sha256(new TextEncoder().encode(`test-device-key:${deviceId}`)),
  );
  return {
    pair,
    privateKey: toBase64Url(pair.privateKey),
    publicKey: toBase64Url(pair.publicKey),
  };
}

// Tickets are "t:<deviceId>:<kind>:<connectionId>", or "t:<deviceId>:<n>"
// for a desktop device whose every dial is a new connection. The real DO
// burns single-use tickets, but the app side never depends on that, so
// the stub just reads who the ticket admits and accepts.
type Holder = { deviceId: string; kind: "desktop" | "web"; connection: string };
function holderOfTicket(ticket: string): Holder | null {
  const [prefix, deviceId, second, third] = ticket.split(":");
  if (prefix !== "t" || !deviceId) return null;
  return second === "web" || second === "desktop"
    ? { deviceId, kind: second, connection: third ?? "" }
    : { deviceId, kind: "desktop", connection: second ?? "" };
}

export type StubHub = {
  port: number;
  hubUrl: string;
  close(): Promise<void>;
};

// `track`, when passed, registers the stub's close on the caller's
// tracker as soon as it listens, the way startDirectListener does.
// `publicKeyOf` names a device's key in the roster where the device's
// key is not its test key (a web profile's, from its stored envelope).
export function startStubHub(
  track?: Track,
  publicKeyOf: (deviceId: string) => string = (deviceId) =>
    testDeviceKey(deviceId).publicKey,
): Promise<StubHub> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    // Each device's sockets by connection id.
    const sockets = new Map<string, Map<string, WebSocket>>();
    const socketsOf = (deviceId: string) => [
      ...(sockets.get(deviceId)?.values() ?? []),
    ];
    const openSocketsOf = (deviceId: string) =>
      socketsOf(deviceId).filter((ws) => ws.readyState === WebSocket.OPEN);
    function broadcastPresence() {
      const ids = [...sockets.keys()].toSorted();
      const text = encodeEnvelope({
        t: "presence",
        online: ids.map((deviceId) => ({
          deviceId,
          publicKey: publicKeyOf(deviceId),
        })),
      });
      for (const deviceId of ids) {
        for (const ws of openSocketsOf(deviceId)) ws.send(text);
      }
    }

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const holder = holderOfTicket(url.searchParams.get("ticket") ?? "");
      if (holder === null) {
        ws.close(4101, "ticket rejected");
        return;
      }
      const { deviceId, kind, connection } = holder;
      const held = sockets.get(deviceId) ?? new Map<string, WebSocket>();
      sockets.set(deviceId, held);
      for (const [id, other] of held) {
        if (kind === "desktop" || id === connection) {
          held.delete(id);
          other.close(CLOSE_SUPERSEDED, "superseded");
        }
      }
      held.set(connection, ws);
      broadcastPresence();
      ws.on("message", (data) => {
        const text = toText(data);
        // The liveness pair the real DO answers through its auto-response.
        if (text === HUB_PING) {
          if (ws.readyState === WebSocket.OPEN) ws.send(HUB_PONG);
          return;
        }
        const envelope = decodeEnvelope(text, DeviceEnvelopeSchema);
        if (envelope === null) return;
        const targets = openSocketsOf(envelope.to);
        if (targets.length === 0) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "offline" }),
          );
          return;
        }
        const outbound = deliveredRelay(deviceId, envelope.frame);
        for (const target of targets) target.send(outbound);
      });
      ws.on("close", () => {
        if (held.get(connection) !== ws) return;
        held.delete(connection);
        if (held.size === 0) sockets.delete(deviceId);
        broadcastPresence();
      });
    });

    wss.on("listening", () => {
      const port = boundPort(wss);
      const close = () =>
        new Promise<void>((done) => {
          for (const deviceId of sockets.keys()) {
            for (const ws of socketsOf(deviceId)) ws.terminate();
          }
          wss.close(() => done());
        });
      track?.(close);
      resolve({
        port,
        hubUrl: `http://127.0.0.1:${port}`,
        close,
      });
    });
  });
}
