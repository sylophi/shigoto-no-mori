// DeviceHub: one Durable Object per account (named by accountId),
// holding every connected device socket for that account and relaying
// opaque envelopes between them. Cross-account isolation is
// structural: a socket only ever lives in its own account's object,
// so there is no account check on the forwarding path because there
// is nothing to check against.
//
// Sockets use the WebSocket Hibernation API: the deviceId rides as
// the accept tag, which survives hibernation, so the message and
// close handlers still know the device after the object was evicted
// from memory.
//
// The worker reaches this object over stub fetches on /internal/*
// paths. Those paths are unreachable from the public internet, the
// worker only ever forwards /internal/connect (for GET /connect) and
// calls the others itself.
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CLOSE_TICKET_REJECTED,
  DeviceEnvelopeSchema,
  decodeEnvelope,
  encodeEnvelope,
  hubTextWithinLimit,
} from "../../shared/hub/protocol.ts";
import type { Env } from "./env.ts";
import { deleteDevice, getDeviceById, touchLastSeen } from "./db.ts";
import { randomBase64url } from "./crypto.ts";

// Worker to DO paths, bodies and responses. These never cross a trust
// boundary (the worker is the only caller), which is why they are
// plain interfaces and casts instead of parsed schemas.
export const INTERNAL_TICKET_PATH = "/internal/ticket";
export const INTERNAL_PRESENCE_PATH = "/internal/presence";
export const INTERNAL_REVOKE_PATH = "/internal/revoke";
export const INTERNAL_CONNECT_PATH = "/internal/connect";

export interface MintTicketRequest {
  deviceId: string;
  ttlMs: number;
}
export interface MintTicketResponse {
  random: string;
}
export interface PresenceResponse {
  online: string[];
}
export interface RevokeRequest {
  deviceId: string;
  // The account the worker already authorized. The D1 delete is scoped
  // to it so a row concurrently re-enrolled under another account
  // cannot be deleted by a stale revoke.
  accountId: string;
}
export interface RevokeResponse {
  ok: true;
}

// A minted, not yet consumed ticket, stored under `ticket:<random>`.
// Only the random half lives here, the account half of the ticket
// string is pure routing handled by the worker.
interface TicketRecord {
  deviceId: string;
  expiresAt: number;
}

const TICKET_KEY_PREFIX = "ticket:";

// storage.delete accepts at most 128 keys per call, so key arrays are
// deleted in batches of this size.
const STORAGE_DELETE_BATCH = 128;

// Upper bound on a single account's unconsumed tickets. A device that
// mints in a loop would otherwise grow DO storage without limit. At
// the cap the oldest ticket is evicted to make room for the new one.
// The ticket store is per-account (one Durable Object per account), so
// this eviction is per-account too. A device minting in a loop can
// evict another of the SAME account's not-yet-consumed tickets. That
// peer would then get CLOSE_TICKET_REJECTED at connect and must
// re-mint. This never crosses an account boundary, because a different
// account's tickets live in a different object entirely.
const MAX_UNCONSUMED_TICKETS = 64;

export class DeviceHub implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case `POST ${INTERNAL_TICKET_PATH}`:
        return await this.mintTicket(request);
      case `GET ${INTERNAL_PRESENCE_PATH}`:
        return Response.json({
          online: this.onlineIds(this.ctx.getWebSockets()),
        } satisfies PresenceResponse);
      case `POST ${INTERNAL_REVOKE_PATH}`:
        return await this.revoke(request);
      case `GET ${INTERNAL_CONNECT_PATH}`:
        return await this.handleConnect(url);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  private async mintTicket(request: Request): Promise<Response> {
    const body = (await request.json()) as MintTicketRequest;
    // Unconsumed tickets are garbage after their minute of validity.
    // Minting is the natural low-frequency moment to sweep them.
    const now = Date.now();
    await this.deleteTicketsWhere((record) => record.expiresAt <= now);
    // Bound the live set. If minting would exceed the cap, evict the
    // oldest tickets by expiresAt first so storage stays bounded even
    // under a device that mints in a loop.
    const live = await this.ctx.storage.list<TicketRecord>({
      prefix: TICKET_KEY_PREFIX,
    });
    if (live.size >= MAX_UNCONSUMED_TICKETS) {
      const overflow = live.size - MAX_UNCONSUMED_TICKETS + 1;
      const oldest = [...live]
        .toSorted(([, a], [, b]) => a.expiresAt - b.expiresAt)
        .slice(0, overflow)
        .map(([key]) => key);
      await this.deleteKeys(oldest);
    }
    const random = randomBase64url(16);
    const record: TicketRecord = {
      deviceId: body.deviceId,
      expiresAt: now + body.ttlMs,
    };
    await this.ctx.storage.put(TICKET_KEY_PREFIX + random, record);
    return Response.json({ random } satisfies MintTicketResponse);
  }

  // Deletes the keys in batches, because storage.delete accepts at most
  // STORAGE_DELETE_BATCH keys per call. The batches touch disjoint keys
  // so they run concurrently.
  private async deleteKeys(keys: string[]): Promise<void> {
    const batches: Promise<unknown>[] = [];
    for (let i = 0; i < keys.length; i += STORAGE_DELETE_BATCH) {
      batches.push(
        this.ctx.storage.delete(keys.slice(i, i + STORAGE_DELETE_BATCH)),
      );
    }
    await Promise.all(batches);
  }

  // Lists the account's tickets once, deletes every record the match
  // selects (chunked by deleteKeys) and returns the count removed. Both
  // the mint-time expiry sweep and the revoke purge go through here, so
  // the list-filter-chunk logic lives in exactly one place.
  private async deleteTicketsWhere(
    match: (record: TicketRecord) => boolean,
  ): Promise<number> {
    const stored = await this.ctx.storage.list<TicketRecord>({
      prefix: TICKET_KEY_PREFIX,
    });
    const keys = [...stored]
      .filter(([, record]) => match(record))
      .map(([key]) => key);
    await this.deleteKeys(keys);
    return keys.length;
  }

  // Revocation is one operation owned by this object: the D1 row, the
  // device's live sockets AND its unconsumed tickets all die together.
  // Ordering is security-critical. The credential kill (the D1 row
  // delete) is awaited FIRST. If it throws we report failure without
  // having claimed success and without force-closing sockets, so a
  // failed delete never leaves a "revoked" device that reconnects with
  // a still-valid credential while the user was told it failed. Only
  // after the row is gone do we purge tickets (a pre-minted ticket must
  // not let a revoked device reconnect within the TTL), close the live
  // sockets and rebroadcast presence.
  private async revoke(request: Request): Promise<Response> {
    const body = (await request.json()) as RevokeRequest;
    const revokedId = body.deviceId;
    try {
      await deleteDevice(this.env.DB, revokedId, body.accountId);
    } catch {
      return new Response(null, { status: 500 });
    }
    await this.deleteTicketsWhere((record) => record.deviceId === revokedId);
    const closing = this.ctx.getWebSockets(revokedId);
    if (closing.length > 0) {
      this.closeAndAnnounce(closing, CLOSE_DEVICE_REVOKED, "device revoked");
    }
    // A JSON body, not a bare 204, so the worker's callObject helper can
    // parse every internal response the same way.
    return Response.json({ ok: true } satisfies RevokeResponse);
  }

  // Named handleConnect because the DurableObject interface reserves
  // `connect` for the TCP socket handler. The whole body is wrapped so
  // ANY throw (storage, acceptWebSocket, D1) becomes a rejected socket,
  // never a rejected fetch that would surface to the client as a 500.
  // The client must always see CLOSE_TICKET_REJECTED. A forged account
  // half still instantiates an empty hibernating DO that immediately
  // rejects here, which is inherent to routing on the ticket's account
  // half. Real rate-limiting is out of scope for this slice.
  private async handleConnect(url: URL): Promise<Response> {
    try {
      const random = url.searchParams.get("random");
      if (random === null) return this.rejectSocket();
      const key = TICKET_KEY_PREFIX + random;
      const record = await this.ctx.storage.get<TicketRecord>(key);
      // Single use: the ticket is burned before any validity verdict,
      // so a replay races nothing.
      if (record) await this.ctx.storage.delete(key);
      if (!record || record.expiresAt <= Date.now()) return this.rejectSocket();
      // Re-verify the device still exists in D1 before accepting the
      // socket. This closes the race where a mint runs concurrently
      // with a revoke. mintTicket authorizes the device with a D1 read
      // on the worker and only later writes the ticket record into this
      // object, so a ticket-put can land after revoke has already purged
      // this device's tickets. revoke deletes the D1 row first, so any
      // connect whose re-check runs after that delete is refused here,
      // and any socket that connected before the delete is caught by
      // revoke's socket-close. This read is once per connection, not a
      // hot path, so the cost is fine. A missing row is treated exactly
      // like an invalid ticket.
      const device = await getDeviceById(this.env.DB, record.deviceId);
      if (device === null) return this.rejectSocket();
      // There is deliberately NO hard admission cap against
      // MAX_ONLINE_DEVICES here: getWebSockets can still list sockets
      // that just closed or are closing (see announcePresence), so a
      // count-based refusal would burn a legitimate device's ticket
      // for a slot that is actually free. At one-user scale the
      // MAX_ONLINE_DEVICES bound stays real as the client's presence
      // schema cap plus the arithmetic proof that a full roster
      // envelope fits the message cap (hub/test/hub.spec.ts), and
      // a correct stale-tolerant admission gate would cost more than
      // that bound is worth.
      // A newer socket for the same deviceId supersedes the old one, so
      // a reconnecting device never fights its own half-dead socket.
      const superseded = this.ctx.getWebSockets(record.deviceId);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [record.deviceId]);
      // Full presence to everyone, including the fresh socket: joining
      // devices learn the room, present devices learn about the join.
      // The broadcast happens before the D1 write so a D1 round trip
      // never gates what other devices see.
      this.closeAndAnnounce(
        superseded,
        CLOSE_SUPERSEDED,
        "superseded by a newer connection",
      );
      // last_seen_at is bookkeeping nothing in the handshake depends
      // on, so it runs off the critical path and never gates the 101.
      void touchLastSeen(this.env.DB, record.deviceId, Date.now()).catch(
        () => {},
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch {
      return this.rejectSocket();
    }
  }

  // The chosen refusal behavior for every admission verdict: complete
  // the upgrade, then close immediately with the typed code. A
  // websocket client sees a real close code this way, which an HTTP
  // status before the upgrade would hide from the browser websocket
  // API.
  private refuseSocket(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(code, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Unknown, expired and replayed tickets all get the one ticket code.
  private rejectSocket(): Response {
    return this.refuseSocket(CLOSE_TICKET_REJECTED, "ticket rejected");
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // The protocol is JSON text. Binary frames are not part of it.
    if (typeof message !== "string") return;
    // Malformed envelopes are dropped, never fatal, mirroring
    // decodeFrame's philosophy on the LAN socket: one bad message must
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

  // Client-initiated close. Runs the departure path for EVERY code,
  // including the two the server also uses (revoked, superseded): the
  // code here is the CLIENT's frame, so a client closing with one of
  // those codes for its own reasons must not stay ghost-online in every
  // peer's roster. Re-running after a server-initiated close is
  // harmless anyway: presence is a full-roster rebroadcast and
  // touchLastSeen on a deleted row updates nothing.
  webSocketClose(ws: WebSocket): void {
    this.handleDeparture(ws);
  }

  // The hibernation runtime calls webSocketError, not webSocketClose,
  // on an abnormal termination (force-quit, dropped network). Without
  // this handler presence is never rebroadcast and peers see a ghost
  // device online forever, so it runs the same departure path.
  webSocketError(ws: WebSocket): void {
    this.handleDeparture(ws);
  }

  // The shared departure path for a socket that left on its own or
  // died abnormally. Presence goes out before the D1 write so a D1
  // round trip never gates what other devices see, and last_seen_at is
  // best-effort off the critical path.
  private handleDeparture(ws: WebSocket): void {
    const deviceId = this.deviceIdOf(ws);
    this.announcePresence(new Set([ws]));
    if (deviceId !== undefined) {
      void touchLastSeen(this.env.DB, deviceId, Date.now()).catch(() => {});
    }
  }

  // The deviceId rides only as the accept tag, so it survives
  // hibernation without a serialized attachment.
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
  // Presence is a full list, so a duplicate broadcast is harmless if
  // the handler runs too.
  private closeAndAnnounce(
    sockets: WebSocket[],
    code: number,
    reason: string,
  ): void {
    for (const ws of sockets) ws.close(code, reason);
    this.announcePresence(new Set(sockets));
  }

  // The membership primitive: everyone still standing gets the full
  // roster. `exclude` is required, not optional, because it encodes the
  // one stale-roster quirk, that getWebSockets can still list sockets
  // that just closed or are closing right now. Callers name the corpses
  // instead of trusting the listing, and a required parameter stops a
  // future caller from reintroducing the stale-roster bug by omitting
  // it. Pass an empty set when nothing is departing.
  private announcePresence(exclude: ReadonlySet<WebSocket>): void {
    const sockets = this.ctx.getWebSockets().filter((ws) => !exclude.has(ws));
    const text = encodeEnvelope({
      t: "presence",
      online: this.onlineIds(sockets),
    });
    for (const ws of sockets) this.safeSend(ws, text);
  }

  // Every ws.send in this object goes through here. A socket can die
  // between listing and sending, and a dead-but-still-listed peer that
  // throws on send must not tear down the caller's socket. On the device hub
  // hot path an unguarded send would let a stale peer kill the sender's
  // socket. A dropped send loses nothing durable. Presence is resent on
  // every membership change and relayed frames are the app's retry
  // concern.
  private safeSend(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      // Dropped on purpose, see above.
    }
  }
}
