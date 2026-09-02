// The websocket half: connect, ticket consumption, presence, relaying,
// nacks, supersede, revoke and cross-account isolation. Everything
// runs against the real DeviceHub Durable Object under workerd.
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CLOSE_TICKET_REJECTED,
  CONNECT_TICKET_PARAM,
  encodeEnvelope,
  MAX_ONLINE_DEVICES,
  MAX_HUB_MESSAGE_BYTES,
  HUB_ROUTES,
  hubTextWithinLimit,
} from "../../shared/hub/protocol.ts";
import { deleteDevice } from "../src/db.ts";
import { buildTicket } from "../src/ticket.ts";
import {
  BASE,
  call,
  closeAllSockets,
  enroll,
  enrollAndConnect,
  mintTicket,
  openSocket,
  revoke,
  sleep,
  ticketRequest,
} from "./helpers.ts";

afterEach(closeAllSockets);

describe("GET /connect", () => {
  it("accepts a fresh ticket and sends the presence list", async () => {
    const { socket } = await enrollAndConnect("acct-conn", "dev-conn");
    await socket.untilPresence(["dev-conn"]);
  });

  it("rejects a structurally malformed ticket before the upgrade", async () => {
    const response = await call(
      new Request(
        `${BASE}${HUB_ROUTES.connect.path}?${CONNECT_TICKET_PARAM}=garbage`,
        { headers: { Upgrade: "websocket" } },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an oversized ticket random with 403, never a 500", async () => {
    // A 3000-character random fails parseTicket's exact-length shape
    // check, so it is rejected as plain HTTP before naming a DO and can
    // never become an oversized storage key that crashes the object.
    const ticket = buildTicket("acct-huge", "x".repeat(3000));
    const params = new URLSearchParams({ [CONNECT_TICKET_PARAM]: ticket });
    const response = await call(
      new Request(`${BASE}${HUB_ROUTES.connect.path}?${params}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("closes with the ticket code when the random half is unknown", async () => {
    await enroll("acct-conn-unknown", "dev-conn-unknown");
    // A well-formed 22-character random (base64url of 16 bytes) that was
    // never minted: the upgrade completes, then the DO rejects it with
    // the ticket close code.
    const socket = await openSocket(
      buildTicket("acct-conn-unknown", "A".repeat(22)),
    );
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });

  it("consumes a ticket on first use, a replay is rejected", async () => {
    const { credential } = await enroll("acct-replay", "dev-replay");
    const { ticket } = await mintTicket(credential);
    const first = await openSocket(ticket);
    await first.untilPresence(["dev-replay"]);
    const replay = await openSocket(ticket);
    expect((await replay.closed).code).toBe(CLOSE_TICKET_REJECTED);
    // The first socket survives the failed replay.
    await first.expectSilence();
  });

  it("rejects an expired ticket", async () => {
    const shortEnv = { ...env, TICKET_TTL_MS: "25" };
    const { credential } = await enroll("acct-expiry", "dev-expiry");
    const { ticket, expiresInMs } = await mintTicket(credential, shortEnv);
    expect(expiresInMs).toBe(25);
    await sleep(60);
    const socket = await openSocket(ticket);
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });

  it("supersedes an older socket for the same deviceId", async () => {
    const { credential, socket: oldSocket } = await enrollAndConnect(
      "acct-supersede",
      "dev-supersede",
    );
    await oldSocket.untilPresence(["dev-supersede"]);
    const { ticket } = await mintTicket(credential);
    const newSocket = await openSocket(ticket);
    expect((await oldSocket.closed).code).toBe(CLOSE_SUPERSEDED);
    // The new socket owns the deviceId now and works normally.
    await newSocket.untilPresence(["dev-supersede"]);
  });
});

describe("relaying", () => {
  it("relays an opaque frame between two devices, byte for byte", async () => {
    const a = await enrollAndConnect("acct-relay", "dev-relay-a");
    const b = await enrollAndConnect("acct-relay", "dev-relay-b");
    await a.socket.untilPresence(["dev-relay-a", "dev-relay-b"]);
    await b.socket.untilPresence(["dev-relay-a", "dev-relay-b"]);
    // Deliberately gnarly: nested, unicode, null and undefined-adjacent
    // shapes, exactly what future sm frames may contain.
    const frame = {
      t: "res",
      id: 7,
      ok: true,
      result: {
        text: "木漏れ日   line-sep",
        list: [1, null, { deep: true }],
        empty: {},
      },
    };
    a.socket.send({ t: "relay", to: "dev-relay-b", frame });
    const delivered = await b.socket.next();
    expect(delivered.t).toBe("relay");
    if (delivered.t !== "relay") return;
    expect(delivered.from).toBe("dev-relay-a");
    expect(JSON.stringify(delivered.frame)).toBe(JSON.stringify(frame));
    // Relaying is symmetric in both directions.
    b.socket.send({ t: "relay", to: "dev-relay-a", frame: "pong" });
    const back = await a.socket.next();
    expect(back).toMatchObject({
      t: "relay",
      from: "dev-relay-b",
      frame: "pong",
    });
  });

  it("nacks a send to an offline device", async () => {
    const { socket } = await enrollAndConnect("acct-nack", "dev-nack-sender");
    await socket.untilPresence(["dev-nack-sender"]);
    socket.send({ t: "relay", to: "dev-nack-nobody", frame: 1 });
    expect(await socket.next()).toEqual({
      t: "nack",
      to: "dev-nack-nobody",
      reason: "offline",
    });
  });

  it("nacks an oversize forward instead of sending it", async () => {
    const a = await enrollAndConnect("acct-big", "dev-big-a");
    const b = await enrollAndConnect("acct-big", "dev-big-b");
    await a.socket.untilPresence(["dev-big-a", "dev-big-b"]);
    await b.socket.untilPresence(["dev-big-a", "dev-big-b"]);
    // Just past the device hub's control-frame cap (64 KiB since the wire
    // went orchestration-only): a legitimate broker frame is far
    // smaller, so anything here is a client aiming data at the wrong
    // wire and gets the nack.
    a.socket.send({
      t: "relay",
      to: "dev-big-b",
      frame: "x".repeat(MAX_HUB_MESSAGE_BYTES + 1),
    });
    expect(await a.socket.next()).toEqual({
      t: "nack",
      to: "dev-big-b",
      reason: "too-large",
    });
    await b.socket.expectSilence();
  });

  it("drops malformed envelopes without killing the socket", async () => {
    const a = await enrollAndConnect("acct-malformed", "dev-malformed-a");
    const b = await enrollAndConnect("acct-malformed", "dev-malformed-b");
    await a.socket.untilPresence(["dev-malformed-a", "dev-malformed-b"]);
    await b.socket.untilPresence(["dev-malformed-a", "dev-malformed-b"]);
    a.socket.ws.send("not json at all");
    a.socket.ws.send(JSON.stringify({ t: "mystery" }));
    a.socket.send({ t: "relay", to: "dev-malformed-b", frame: "still alive" });
    const delivered = await b.socket.next();
    expect(delivered).toMatchObject({ t: "relay", frame: "still alive" });
  });

  it("never crosses accounts", async () => {
    const a = await enrollAndConnect("acct-iso-a", "dev-iso-a");
    const b = await enrollAndConnect("acct-iso-b", "dev-iso-b");
    await a.socket.untilPresence(["dev-iso-a"]);
    await b.socket.untilPresence(["dev-iso-b"]);
    // Account A addressing account B's deviceId lands in A's own DO,
    // where that device does not exist.
    a.socket.send({ t: "relay", to: "dev-iso-b", frame: "should not arrive" });
    expect(await a.socket.next()).toEqual({
      t: "nack",
      to: "dev-iso-b",
      reason: "offline",
    });
    await b.socket.expectSilence();
  });
});

describe("presence", () => {
  it("broadcasts the full list on join and leave", async () => {
    const a = await enrollAndConnect("acct-pres", "dev-pres-a");
    await a.socket.untilPresence(["dev-pres-a"]);
    const b = await enrollAndConnect("acct-pres", "dev-pres-b");
    await b.socket.untilPresence(["dev-pres-a", "dev-pres-b"]);
    await a.socket.untilPresence(["dev-pres-a", "dev-pres-b"]);
    b.socket.close();
    await a.socket.untilPresence(["dev-pres-a"]);
  });

  it("rebroadcasts presence on departure via the shared close and error path", async () => {
    // webSocketClose (clean) and webSocketError (abnormal termination)
    // both route through the DO's handleDeparture, so peers always see
    // a departure reflected in presence and never a ghost device. The
    // test harness can drive the clean-close side directly, which
    // exercises that shared path.
    const a = await enrollAndConnect("acct-depart", "dev-depart-a");
    await a.socket.untilPresence(["dev-depart-a"]);
    const b = await enrollAndConnect("acct-depart", "dev-depart-b");
    await a.socket.untilPresence(["dev-depart-a", "dev-depart-b"]);
    b.socket.close();
    await a.socket.untilPresence(["dev-depart-a"]);
  });

  it("rebroadcasts presence even when a client closes with a server-owned code", async () => {
    // The close code on webSocketClose is the CLIENT's frame, so a
    // client closing with the codes the server also uses (revoked,
    // superseded) must still run the departure path. A guard on those
    // codes once left such a device ghost-online in every peer's
    // roster.
    const a = await enrollAndConnect("acct-code", "dev-code-a");
    await a.socket.untilPresence(["dev-code-a"]);
    const b = await enrollAndConnect("acct-code", "dev-code-b");
    await a.socket.untilPresence(["dev-code-a", "dev-code-b"]);
    b.socket.ws.close(CLOSE_SUPERSEDED, "client picked this code");
    await a.socket.untilPresence(["dev-code-a"]);
    const c = await enrollAndConnect("acct-code", "dev-code-c");
    await a.socket.untilPresence(["dev-code-a", "dev-code-c"]);
    c.socket.ws.close(CLOSE_DEVICE_REVOKED, "client picked this code");
    await a.socket.untilPresence(["dev-code-a"]);
  });
});

describe("ticket storage bounds", () => {
  it("evicts the oldest tickets past the unconsumed cap", async () => {
    const { credential } = await enroll("acct-cap", "dev-cap");
    // MAX_UNCONSUMED_TICKETS is 64. The first ticket is minted, then
    // enough more to push past the cap so the oldest (the first) is
    // evicted while live storage stays bounded.
    const first = await mintTicket(credential);
    for (let i = 0; i < 66; i++) {
      // oxlint-disable-next-line no-await-in-loop -- minting is sequential by design here
      await mintTicket(credential);
    }
    const last = await mintTicket(credential);
    // The evicted first ticket no longer connects.
    const evicted = await openSocket(first.ticket);
    expect((await evicted.closed).code).toBe(CLOSE_TICKET_REJECTED);
    // A recent ticket still works, so the cap evicts rather than breaks
    // minting.
    const live = await openSocket(last.ticket);
    await live.untilPresence(["dev-cap"]);
  });
});

describe("hubTextWithinLimit UTF-8 band", () => {
  it("rejects a multi-byte string whose real encode crosses the cap", () => {
    // 25k Japanese characters: length passes the first guard, but the
    // fast upper-bound path does not, so the third branch runs a real
    // UTF-8 encode. Each character is 3 bytes, so the encode sees
    // about 75 KB and rejects against the 64 KiB cap.
    const text = "木".repeat(25_000);
    expect(text.length).toBeLessThanOrEqual(MAX_HUB_MESSAGE_BYTES);
    expect(text.length * 3).toBeGreaterThan(MAX_HUB_MESSAGE_BYTES);
    expect(hubTextWithinLimit(text)).toBe(false);
  });

  it("accepts a mostly-ASCII string in the band once actually encoded", () => {
    // Length forces the real encode, but the bytes stay under the cap,
    // so the third branch accepts it. sm mixes Japanese content into
    // otherwise ASCII JSON, so this band is real traffic.
    const text = "a".repeat(22_000) + "木漏れ日";
    expect(text.length).toBeGreaterThan(Math.floor(MAX_HUB_MESSAGE_BYTES / 3));
    expect(hubTextWithinLimit(text)).toBe(true);
  });
});

describe("orchestration-only caps", () => {
  it("keeps the worst-case presence roster under the message cap", () => {
    // The presence envelope is not size-guarded on send, so a full
    // roster envelope MUST fit the message cap or presence itself
    // would trip inbound payload bounds. The DO runs no admission gate
    // against MAX_ONLINE_DEVICES (stale socket listings make a correct
    // one cost more than the bound is worth, see hubObject.ts), so
    // this arithmetic plus the client's presence schema cap IS the
    // bound. Worst case: MAX_ONLINE_DEVICES ids, each at the
    // DeviceIdSchema ceiling of 200 characters (a deviceId is
    // schema-bounded on enroll, so no real id exceeds it). Built with
    // the real encodeEnvelope so growth in the envelope shape cannot
    // silently outgrow this guard.
    const worstCase = encodeEnvelope({
      t: "presence",
      online: Array.from({ length: MAX_ONLINE_DEVICES }, () => "x".repeat(200)),
    });
    expect(hubTextWithinLimit(worstCase)).toBe(true);
    // Headroom, not a squeeze: the arithmetic should not sit within a
    // stray field of the cap.
    expect(worstCase.length).toBeLessThan(MAX_HUB_MESSAGE_BYTES / 2);
  });
});

describe("revocation", () => {
  it("closes the revoked device's socket and kills its credential", async () => {
    const keeper = await enrollAndConnect("acct-rev", "dev-rev-keeper");
    const victim = await enrollAndConnect("acct-rev", "dev-rev-victim");
    await keeper.socket.untilPresence(["dev-rev-keeper", "dev-rev-victim"]);
    const response = await revoke(keeper.credential, "dev-rev-victim");
    expect(response.status).toBe(204);
    expect((await victim.socket.closed).code).toBe(CLOSE_DEVICE_REVOKED);
    await keeper.socket.untilPresence(["dev-rev-keeper"]);
    // The victim's credential is dead for every endpoint.
    const ticketAttempt = await call(ticketRequest(victim.credential));
    expect(ticketAttempt.status).toBe(401);
  });

  it("purges the revoked device's unconsumed tickets", async () => {
    const keeper = await enroll("acct-rev-ticket", "dev-rev-ticket-keeper");
    const victim = await enroll("acct-rev-ticket", "dev-rev-ticket-victim");
    // Minted before the revocation, so it would otherwise stay valid
    // for the full TTL and let the revoked device reconnect.
    const { ticket } = await mintTicket(victim.credential);
    const response = await revoke(keeper.credential, "dev-rev-ticket-victim");
    expect(response.status).toBe(204);
    const socket = await openSocket(ticket);
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });

  it("rejects a pre-minted ticket once the device row is gone, even when the ticket record survives", async () => {
    // This exercises the D1 existence gate in handleConnect, not the
    // ticket purge. Mint a ticket, then delete the device row directly,
    // bypassing revoke's ticket purge, so the ticket record is still
    // present and unexpired at connect time. handleConnect re-reads D1,
    // finds no device and rejects. This is the mint-concurrent-with-
    // revoke race: a ticket whose put landed after revoke's purge must
    // still not open a socket for a device whose D1 row is already gone.
    const { credential } = await enroll("acct-rev-d1", "dev-rev-d1");
    const { ticket } = await mintTicket(credential);
    // Delete the row out of band so the DO's ticket record survives and
    // only the D1 existence check can catch this.
    await deleteDevice(env.DB, "dev-rev-d1", "acct-rev-d1");
    const socket = await openSocket(ticket);
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });
});
