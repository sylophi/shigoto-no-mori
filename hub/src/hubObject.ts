// DeviceHub: one Durable Object per account (named by accountId),
// holding every connected device socket for that account and relaying
// opaque envelopes between them. Cross-account isolation is
// structural: a socket only ever lives in its own account's object,
// so there is no account check on the forwarding path because there
// is nothing to check against.
//
// The Worker calls the object's methods directly (mintTicket, online,
// revoke). Its fetch takes one request only, the websocket upgrade the
// Worker forwards for GET /connect, since an upgrade cannot ride a
// method call.
//
// Sockets use the WebSocket Hibernation API: each is tagged with its
// device id and its connection (connectionTag), and tags survive
// hibernation, so the handlers still know the socket after the object
// was evicted from memory. A web device holds a connection per tab and
// the object relays to each. A desktop device holds one.
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CLOSE_TICKET_REJECTED,
  DeviceEnvelopeSchema,
  decodeEnvelope,
  encodeEnvelope,
  HUB_PING,
  HUB_PONG,
  hubTextWithinLimit,
} from "@shigomori/contracts/hubProtocol";
import { type Env, WorkerEnv } from "./env.ts";
import * as Registry from "./Registry.ts";
import * as Tickets from "./Tickets.ts";

// The query parameter the Worker hands the ticket's random half in.
export const CONNECT_RANDOM_PARAM = "random";

// The tag naming one connection of a device.
const connectionTag = (deviceId: string, connectionId: string) =>
  `${deviceId}#${connectionId}`;

export class DeviceHub extends DurableObject<Env> {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Registry.Registry | Tickets.Tickets,
    unknown
  >;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The devices' liveness pings (packages/contracts/src/hubProtocol.ts)
    // are answered by the runtime itself, without waking a hibernated
    // object: a device heartbeating every few seconds must not cost a
    // request or an eviction each time.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HUB_PING, HUB_PONG),
    );
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Tickets.layer.pipe(
          Layer.provide(SqliteClient.layer({ storage: ctx.storage })),
        ),
        Registry.layer,
      ).pipe(Layer.provide(Layer.succeed(WorkerEnv, env))),
    );
    // The ticket table's migration runs before the object takes any
    // call.
    void ctx.blockConcurrencyWhile(() => this.runtime.runPromise(Effect.void));
  }

  async mintTicket(
    holder: Tickets.TicketHolder,
    ttlMs: number,
  ): Promise<string> {
    return await this.runtime.runPromise(
      Effect.flatMap(Tickets.Tickets, (tickets) => tickets.mint(holder, ttlMs)),
    );
  }

  online(): string[] {
    return this.onlineIds(this.ctx.getWebSockets());
  }

  // Revocation is one operation owned by this object: the D1 row, the
  // device's live sockets and its unconsumed tickets go together. The
  // credential kill (the row delete) comes first, and a failure rejects
  // before anything else happens, so a failed delete never leaves a
  // "revoked" device that reconnects with a still-valid credential while
  // the user was told it failed. Only after the row is gone are the
  // tickets dropped (a pre-minted ticket must not let a revoked device
  // back in within its TTL) and the sockets closed.
  async revoke(deviceId: string, accountId: string): Promise<void> {
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const tickets = yield* Tickets.Tickets;
        yield* registry.remove(deviceId, accountId);
        yield* tickets.dropDevice(deviceId);
      }),
    );
    const closing = this.ctx.getWebSockets(deviceId);
    if (closing.length > 0) {
      this.closeAndAnnounce(closing, CLOSE_DEVICE_REVOKED, "device revoked");
    }
  }

  // The upgrade for GET /connect. Every verdict is an accepted socket:
  // a refused one closes at once with the ticket code, which a browser's
  // websocket shows where it hides an HTTP status. The Worker only
  // forwards tickets it signed itself (src/ticket.ts), so what reaches
  // here unknown is a real ticket that expired, was replayed or was
  // dropped by a revoke.
  override async fetch(request: Request): Promise<Response> {
    const random = new URL(request.url).searchParams.get(CONNECT_RANDOM_PARAM);
    const admitted =
      random === null
        ? null
        : await this.runtime.runPromise(
            Effect.gen(function* () {
              const tickets = yield* Tickets.Tickets;
              const registry = yield* Registry.Registry;
              const holder = yield* tickets.take(random);
              if (holder === null) return null;
              // The device must still be enrolled. A mint racing a
              // revoke can store its ticket after the revoke dropped
              // the device's tickets, and the row delete comes first,
              // so this read catches what the drop missed.
              const device = yield* registry.byId(holder.deviceId);
              return device === null ? null : holder;
            }).pipe(Effect.orElseSucceed(() => null)),
          );
    if (admitted === null) {
      return this.refuseSocket(CLOSE_TICKET_REJECTED, "ticket rejected");
    }
    // There is deliberately NO admission cap against MAX_ONLINE_DEVICES:
    // getWebSockets can still list sockets that just closed, so a
    // count-based refusal would burn a legitimate device's ticket for a
    // slot that is actually free. The bound holds as the client's
    // presence schema cap and the proof that a full roster fits the
    // message cap (hub/test/hub.spec.ts).
    //
    // A connection dialing again supersedes its own older socket, so a
    // reconnect never fights its own half-dead one. On a desktop device
    // a second connection supersedes the first too, since there it
    // means two app instances on one root. A web device's tabs stand
    // side by side.
    const { deviceId, kind, connectionId } = admitted;
    const tag = connectionTag(deviceId, connectionId);
    const superseded = this.ctx.getWebSockets(
      kind === "desktop" ? deviceId : tag,
    );
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [deviceId, tag]);
    // Full presence to everyone, including the fresh socket: joining
    // devices learn the room, present devices learn about the join.
    this.closeAndAnnounce(
      superseded,
      CLOSE_SUPERSEDED,
      "superseded by a newer connection",
    );
    this.touchLastSeen(deviceId);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private refuseSocket(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(code, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // The protocol is JSON text. Binary frames are not part of it.
    if (typeof message !== "string") return;
    // Malformed envelopes are dropped, never fatal: one bad message must
    // not tear down a socket carrying live traffic.
    const envelope = decodeEnvelope(message, DeviceEnvelopeSchema);
    if (!envelope) return;
    const from = this.deviceIdOf(ws);
    if (from === undefined) return;
    const targets = this.ctx.getWebSockets(envelope.to);
    if (targets.length === 0) {
      this.safeSend(
        ws,
        encodeEnvelope({ t: "nack", to: envelope.to, reason: "offline" }),
      );
      return;
    }
    // The frame is copied verbatim into the outbound envelope. The
    // hub never reads it.
    const outbound = encodeEnvelope({
      t: "relay",
      from,
      frame: envelope.frame,
    });
    if (!hubTextWithinLimit(outbound)) {
      this.safeSend(
        ws,
        encodeEnvelope({ t: "nack", to: envelope.to, reason: "too-large" }),
      );
      return;
    }
    for (const target of targets) this.safeSend(target, outbound);
  }

  // Runs the departure path for every close code, the two the server
  // uses included: the code here is the client's, so a client closing
  // with one of them for its own reasons must not stay online in every
  // roster. Presence is a full list, so running after a server close
  // too is harmless.
  override webSocketClose(ws: WebSocket) {
    this.handleDeparture(ws);
  }

  // The hibernation runtime calls this, not webSocketClose, on an
  // abnormal termination (force-quit, dropped network). Without it
  // peers would see the device online forever.
  override webSocketError(ws: WebSocket) {
    this.handleDeparture(ws);
  }

  private handleDeparture(ws: WebSocket): void {
    const deviceId = this.deviceIdOf(ws);
    this.announcePresence(new Set([ws]));
    if (deviceId !== undefined) this.touchLastSeen(deviceId);
  }

  // last_seen_at is bookkeeping nothing waits on, so it runs off the
  // critical path, after what other devices see.
  private touchLastSeen(deviceId: string): void {
    this.runtime.runFork(
      Effect.ignore(
        Effect.flatMap(Registry.Registry, (registry) =>
          registry.touchLastSeen(deviceId),
        ),
      ),
    );
  }

  // The device id is the first accept tag, so it survives hibernation
  // without a serialized attachment.
  private deviceIdOf(ws: WebSocket): string | undefined {
    return this.ctx.getTags(ws)[0];
  }

  private onlineIds(sockets: WebSocket[]): string[] {
    const ids = new Set<string>();
    for (const ws of sockets) {
      const deviceId = this.deviceIdOf(ws);
      if (deviceId !== undefined) ids.add(deviceId);
    }
    return [...ids].toSorted();
  }

  // Closes the given sockets, then broadcasts the presence list
  // without them. A server-initiated close does not reliably run
  // webSocketClose, so the broadcast cannot be left to the handler.
  private closeAndAnnounce(
    sockets: WebSocket[],
    code: number,
    reason: string,
  ): void {
    for (const ws of sockets) ws.close(code, reason);
    this.announcePresence(new Set(sockets));
  }

  // Everyone still standing gets the full roster. `exclude` is
  // required because getWebSockets can still list sockets that just
  // closed or are closing: callers name the departing ones instead of
  // trusting the listing.
  private announcePresence(exclude: ReadonlySet<WebSocket>): void {
    const sockets = this.ctx.getWebSockets().filter((ws) => !exclude.has(ws));
    const text = encodeEnvelope({
      t: "presence",
      online: this.onlineIds(sockets),
    });
    for (const ws of sockets) this.safeSend(ws, text);
  }

  // A socket can die between listing and sending, and a dead peer that
  // throws on send must not tear down the caller's socket. A dropped
  // send loses nothing durable: presence is resent on every change and
  // relayed frames are the app's retry concern.
  private safeSend(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      // Dropped on purpose, see above.
    }
  }
}
