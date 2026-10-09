// The stub Durable Object shared by the hub-transport checks: a node
// ws server implementing hubObject.ts's envelope behavior (deliver
// forwarding to every socket of a device, full-roster presence on join
// and leave, offline and too-large nacks, and supersede: a desktop
// device's second socket, or a connection dialing again). Extracted from
// hub-link.mts so sync-transfer.mts drives the same stub
// instead of a second copy.
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_SUPERSEDED,
  decodeEnvelope,
  DeviceEnvelopeSchema,
  encodeEnvelope,
  HUB_PING,
  HUB_PONG,
  hubTextWithinLimit,
  type ServerEnvelope,
} from "@shigomori/contracts/hubProtocol";
import { toText } from "@host/hub/rawData";
import { boundPort, type Track } from "./checkKit.mts";

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

type StubSend = { from: string; to: string; frame: unknown };

export type StubHub = {
  port: number;
  hubUrl: string;
  received: StubSend[];
  receivedCount(): number;
  forwardedCount(): number;
  sendsFrom(deviceId: string): number;
  sentTo(from: string, to: string): boolean;
  injectTo(deviceId: string, envelopeOrText: ServerEnvelope | string): void;
  pingsFrom(deviceId: string): number;
  setAnswerPings(value: boolean): void;
  dropSocket(deviceId: string, code?: number, reason?: string): void;
  close(): Promise<void>;
};

// `track`, when passed, registers the stub's close on the caller's
// tracker as soon as it listens, the way startDirectListener does.
export function startStubHub(track?: Track): Promise<StubHub> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    // Each device's sockets by connection id.
    const sockets = new Map<string, Map<string, WebSocket>>();
    const socketsOf = (deviceId: string) => [
      ...(sockets.get(deviceId)?.values() ?? []),
    ];
    const openSocketsOf = (deviceId: string) =>
      socketsOf(deviceId).filter((ws) => ws.readyState === WebSocket.OPEN);
    // Every device envelope the stub received, parsed, plus counters so
    // a test can assert a frame never hit the wire.
    const received: StubSend[] = [];
    let forwarded = 0;
    // The liveness pair the real DO answers through its auto-response.
    // A test flips answerPings off to play a hub whose socket died
    // silently, and reads pingsFrom to assert a device heartbeats.
    let answerPings = true;
    const pings = new Map<string, number>();

    function broadcastPresence() {
      const online = [...sockets.keys()].toSorted();
      const text = encodeEnvelope({ t: "presence", online });
      for (const deviceId of online) {
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
        if (text === HUB_PING) {
          pings.set(deviceId, (pings.get(deviceId) ?? 0) + 1);
          if (answerPings && ws.readyState === WebSocket.OPEN) {
            ws.send(HUB_PONG);
          }
          return;
        }
        const envelope = decodeEnvelope(text, DeviceEnvelopeSchema);
        if (envelope === null) return;
        received.push({
          from: deviceId,
          to: envelope.to,
          frame: envelope.frame,
        });
        const targets = openSocketsOf(envelope.to);
        if (targets.length === 0) {
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
        if (!hubTextWithinLimit(outbound)) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "too-large" }),
          );
          return;
        }
        forwarded += 1;
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
        // text) straight to a connected device, the seam a hostile-hub
        // test drives.
        injectTo(deviceId, envelopeOrText) {
          const text =
            typeof envelopeOrText === "string"
              ? envelopeOrText
              : encodeEnvelope(envelopeOrText);
          for (const ws of openSocketsOf(deviceId)) ws.send(text);
        },
        // The liveness seams: how many pings a device sent, and whether
        // the stub answers them (off plays a silently dead hub).
        pingsFrom: (deviceId) => pings.get(deviceId) ?? 0,
        setAnswerPings(value) {
          answerPings = value;
        },
        // Server-initiated close for one device's socket, the seam the
        // revoked/superseded/reconnect tests drive.
        dropSocket(deviceId, code, reason = "") {
          for (const ws of socketsOf(deviceId)) ws.close(code, reason);
        },
        close,
      });
    });
  });
}
