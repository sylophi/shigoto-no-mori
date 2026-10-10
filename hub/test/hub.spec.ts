// The websocket half: connect, ticket consumption, presence, relaying,
// nacks, supersede, revoke and cross-account isolation. Everything
// runs against the real DeviceHub Durable Object under workerd.
import { afterEach, describe, expect, it } from "vitest";
import { env, listDurableObjectIds } from "cloudflare:test";
import {
  CLOSE_CREDENTIAL_ROTATED,
  CLOSE_DEVICE_REVOKED,
  CLOSE_RATE_LIMITED,
  CLOSE_SUPERSEDED,
  CLOSE_TICKET_REJECTED,
  encodeEnvelope,
  MAX_DEVICE_CONNECTIONS,
  MAX_ACCOUNT_DEVICES,
  MAX_ONLINE_DEVICES,
  MAX_HUB_MESSAGE_BYTES,
  hubTextWithinLimit,
  HUB_PING,
  HUB_PONG,
} from "@shigomori/contracts/hubProtocol";
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
  newConnectionId,
  testPublicKey,
  ticketRequest,
} from "./helpers.ts";

afterEach(closeAllSockets);

// A ticket signed like the worker signs one, for the specs that need a
// well-formed ticket the hub never minted.
async function signedTicket(accountId: string, random: string) {
  return await buildTicket(env.TICKET_SIGNING_KEY ?? "", accountId, random);
}

describe("GET /connect", () => {
  it("accepts a fresh ticket and sends the presence list", async () => {
    const { socket } = await enrollAndConnect("acct-conn", "dev-conn");
    await socket.untilPresence(["dev-conn"]);
  });

  it("names each online device with the key it enrolled with", async () => {
    const a = await enrollAndConnect("acct-keys", "dev-keys-a");
    const b = await enrollAndConnect("acct-keys", "dev-keys-b");
    const roster = await b.socket.untilPresence(["dev-keys-a", "dev-keys-b"]);
    expect(roster).toEqual([
      { deviceId: "dev-keys-a", publicKey: testPublicKey("dev-keys-a") },
      { deviceId: "dev-keys-b", publicKey: testPublicKey("dev-keys-b") },
    ]);
    await a.socket.untilPresence(["dev-keys-a", "dev-keys-b"]);
  });

  it("refuses the socket of a device enrolled before keys", async () => {
    const { credential } = await enroll("acct-keyless", "dev-keyless");
    await env.DB.prepare(
      "UPDATE devices SET public_key = NULL WHERE device_id = ?",
    )
      .bind("dev-keyless")
      .run();
    const { ticket } = await mintTicket(credential);
    const socket = await openSocket(ticket);
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });

  it("rejects a structurally malformed ticket before the upgrade", async () => {
    const response = await call(
      new Request(`${BASE}/connect?ticket=garbage`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an oversized ticket random with 403, never a 500", async () => {
    // A 3000-character random fails parseTicket's exact-length shape
    // check, so it is rejected as plain HTTP before naming a DO and can
    // never become an oversized storage key that crashes the object.
    const ticket = await signedTicket("acct-huge", "x".repeat(3000));
    const params = new URLSearchParams({ ticket: ticket });
    const response = await call(
      new Request(`${BASE}/connect?${params}`, {
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
      await signedTicket("acct-conn-unknown", "A".repeat(22)),
    );
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });

  it("rejects a ticket this worker did not sign before naming a DO", async () => {
    // GET /connect takes no credential, so the signature is all that
    // stops a caller from instantiating a Durable Object per request
    // under any name it likes. Both forgeries are well-formed: one
    // signed with the wrong key, one with the account half swapped
    // under a genuine signature.
    const { credential } = await enroll("acct-forge-real", "dev-forge");
    const { ticket: genuine } = await mintTicket(credential);
    const [, random = "", signature = ""] = genuine.split(".");
    const swapped = `${(await signedTicket("acct-forged-swap", random)).split(".")[0]}.${random}.${signature}`;
    const wrongKey = await buildTicket(
      "not-the-key",
      "acct-forged-key",
      "A".repeat(22),
    );
    for (const ticket of [swapped, wrongKey]) {
      const params = new URLSearchParams({ ticket: ticket });
      // oxlint-disable-next-line no-await-in-loop -- two requests, and a failure should name which forgery got through
      const response = await call(
        new Request(`${BASE}/connect?${params}`, {
          headers: { Upgrade: "websocket" },
        }),
      );
      expect(response.status).toBe(403);
    }
    const ids = await listDurableObjectIds(env.DEVICE_HUB);
    for (const forged of ["acct-forged-swap", "acct-forged-key"]) {
      const id = env.DEVICE_HUB.idFromName(forged);
      expect(ids.some((made) => made.equals(id))).toBe(false);
    }
    // The genuine ticket was untouched by the forgeries around it.
    const socket = await openSocket(genuine);
    await socket.untilPresence(["dev-forge"]);
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

  it("supersedes a desktop device's older socket, whatever its connection", async () => {
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

describe("a web device's tabs", () => {
  it("holds a socket per tab, relays to each, and names the device once in presence", async () => {
    const { credential } = await enroll(
      "acct-tabs",
      "dev-tabs-web",
      "Chrome on macOS",
      "web",
      "browser",
    );
    const tabA = await openSocket((await mintTicket(credential)).ticket);
    const tabB = await openSocket((await mintTicket(credential)).ticket);
    await tabA.untilPresence(["dev-tabs-web"]);
    await tabB.untilPresence(["dev-tabs-web"]);
    const peer = await enrollAndConnect("acct-tabs", "dev-tabs-peer");
    await peer.socket.untilPresence(["dev-tabs-peer", "dev-tabs-web"]);
    peer.socket.send({ t: "relay", to: "dev-tabs-web", frame: "one" });
    for (const tab of [tabA, tabB]) {
      // oxlint-disable-next-line no-await-in-loop -- two tabs, each reads its own queue
      await tab.untilRelay("one");
    }
    // One tab closing leaves the device online through the other.
    tabA.close();
    await peer.socket.untilPresence(["dev-tabs-peer", "dev-tabs-web"]);
    tabB.close();
    await peer.socket.untilPresence(["dev-tabs-peer"]);
  });

  it("lets a tab's redial supersede its own socket and no other tab's", async () => {
    const { credential } = await enroll(
      "acct-redial",
      "dev-redial-web",
      "Chrome on macOS",
      "web",
      "browser",
    );
    const connection = newConnectionId();
    const stale = await openSocket(
      (await mintTicket(credential, env, connection)).ticket,
    );
    const other = await openSocket((await mintTicket(credential)).ticket);
    await other.untilPresence(["dev-redial-web"]);
    const redial = await openSocket(
      (await mintTicket(credential, env, connection)).ticket,
    );
    expect((await stale.closed).code).toBe(CLOSE_SUPERSEDED);
    await redial.untilPresence(["dev-redial-web"]);
    other.send({ t: "relay", to: "dev-redial-web", frame: "still here" });
    await redial.untilRelay("still here");
  });
});

describe("a device's socket cap", () => {
  it("lets the oldest of a device's sockets give way past the cap, whatever its kind", async () => {
    const { credential } = await enroll(
      "acct-socket-cap",
      "dev-socket-cap",
      "Chrome on macOS",
      "web",
      "browser",
    );
    const sockets = [];
    for (let i = 0; i < MAX_DEVICE_CONNECTIONS; i++) {
      // oxlint-disable-next-line no-await-in-loop -- age is open order, so these have to land one at a time
      sockets.push(await openSocket((await mintTicket(credential)).ticket));
    }
    const [oldest, next] = sockets;
    if (oldest === undefined || next === undefined) {
      throw new Error("the cap is at least two");
    }
    await next.untilPresence(["dev-socket-cap"]);
    const newest = await openSocket((await mintTicket(credential)).ticket);
    expect((await oldest.closed).code).toBe(CLOSE_SUPERSEDED);
    await newest.untilPresence(["dev-socket-cap"]);
    await next.untilPresence(["dev-socket-cap"]);
  });
});

describe("rotation", () => {
  it("closes the device's sockets when it enrolls again, and they dial back with the new credential", async () => {
    const { socket } = await enrollAndConnect("acct-rotate", "dev-rotate");
    await socket.untilPresence(["dev-rotate"]);
    const watcher = await enrollAndConnect("acct-rotate", "dev-rotate-peer");
    await watcher.socket.untilPresence(["dev-rotate", "dev-rotate-peer"]);
    const { credential } = await enroll("acct-rotate", "dev-rotate");
    expect((await socket.closed).code).toBe(CLOSE_CREDENTIAL_ROTATED);
    await watcher.socket.untilPresence(["dev-rotate-peer"]);
    const redial = await openSocket((await mintTicket(credential)).ticket);
    await redial.untilPresence(["dev-rotate", "dev-rotate-peer"]);
  });

  it("refuses a ticket minted before the device enrolled again", async () => {
    const first = await enroll("acct-rotate-ticket", "dev-rotate-ticket");
    const { ticket } = await mintTicket(first.credential);
    await enroll("acct-rotate-ticket", "dev-rotate-ticket");
    const socket = await openSocket(ticket);
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });

  it("refuses a ticket stored under a credential the device no longer holds", async () => {
    // A mint that read the old credential and stored its ticket after
    // the rotation dropped the device's tickets.
    await enroll("acct-rotate-race", "dev-rotate-race");
    const hub = env.DEVICE_HUB.get(
      env.DEVICE_HUB.idFromName("acct-rotate-race"),
    );
    const random = await hub.mintTicket(
      {
        deviceId: "dev-rotate-race",
        kind: "desktop",
        connectionId: newConnectionId(),
        credentialHash: "a credential rotated away",
      },
      60_000,
    );
    const socket = await openSocket(
      await signedTicket("acct-rotate-race", random),
    );
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });
});

describe("relaying", () => {
  it("relays an opaque frame between two devices, unchanged", async () => {
    const a = await enrollAndConnect("acct-hub", "dev-hub-a");
    const b = await enrollAndConnect("acct-hub", "dev-hub-b");
    await a.socket.untilPresence(["dev-hub-a", "dev-hub-b"]);
    await b.socket.untilPresence(["dev-hub-a", "dev-hub-b"]);
    // Deliberately gnarly: the hub must not care what the string holds.
    const frame = 'ask:7:{"木漏れ日"}\u2028 "quoted" \\ end';
    a.socket.send({ t: "relay", to: "dev-hub-b", frame });
    const delivered = await b.socket.next();
    expect(delivered.t).toBe("relay");
    if (delivered.t !== "relay") return;
    expect(delivered.from).toBe("dev-hub-a");
    expect(delivered.frame).toBe(frame);
    // Relaying is symmetric in both directions.
    b.socket.send({ t: "relay", to: "dev-hub-a", frame: "pong" });
    const back = await a.socket.next();
    expect(back).toMatchObject({
      t: "relay",
      from: "dev-hub-b",
      frame: "pong",
    });
  });

  it("nacks a send to an offline device", async () => {
    const { socket } = await enrollAndConnect("acct-nack", "dev-nack-sender");
    await socket.untilPresence(["dev-nack-sender"]);
    socket.send({ t: "relay", to: "dev-nack-nobody", frame: "1" });
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
    // A send right at the device hub's control-frame cap (64 KiB since
    // the wire went orchestration-only), whose forward, naming the
    // sender where the send named the target, lands just past it: a
    // legitimate broker frame is far smaller, so anything here is a
    // client aiming data at the wrong wire and gets the nack.
    const overhead = encodeEnvelope({
      t: "relay",
      to: "dev-big-b",
      frame: "",
    }).length;
    a.socket.send({
      t: "relay",
      to: "dev-big-b",
      frame: "x".repeat(MAX_HUB_MESSAGE_BYTES - overhead),
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
    // A frame is a string: anything else is not relayed.
    a.socket.ws.send(
      JSON.stringify({ t: "relay", to: "dev-malformed-b", frame: { a: 1 } }),
    );
    a.socket.send({ t: "relay", to: "dev-malformed-b", frame: "still alive" });
    const delivered = await b.socket.next();
    expect(delivered).toMatchObject({ t: "relay", frame: "still alive" });
  });

  it("answers the liveness ping with a pong, without waking the object", async () => {
    // The devices heartbeat with the bare HUB_PING text and the runtime's
    // auto-response answers HUB_PONG (hubObject.ts constructor), so a
    // ping never reaches webSocketMessage and never costs a request. A
    // bare "pong" is not an envelope, so it is read raw here.
    const a = await enrollAndConnect("acct-ping", "dev-ping-a");
    await a.socket.untilPresence(["dev-ping-a"]);
    const pong = new Promise<string>((resolve) => {
      a.socket.ws.addEventListener("message", (event) => {
        if (event.data === HUB_PONG) resolve(event.data);
      });
    });
    a.socket.ws.send(HUB_PING);
    expect(await pong).toBe(HUB_PONG);
    // The socket is untouched by the exchange: a relay still works.
    const b = await enrollAndConnect("acct-ping", "dev-ping-b");
    await b.socket.untilPresence(["dev-ping-a", "dev-ping-b"]);
    a.socket.send({ t: "relay", to: "dev-ping-b", frame: "after ping" });
    expect(await b.socket.next()).toMatchObject({
      t: "relay",
      frame: "after ping",
    });
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

describe("what a socket may send", () => {
  it("cuts a socket that sends more than any envelope could be, before parsing it", async () => {
    const { socket } = await enrollAndConnect("acct-input-size", "dev-input");
    await socket.untilPresence(["dev-input"]);
    socket.ws.send("x".repeat(MAX_HUB_MESSAGE_BYTES + 1));
    expect((await socket.closed).code).toBe(1009);
  });

  it("cuts a socket that sends faster than its budget", async () => {
    const { socket } = await enrollAndConnect("acct-input-rate", "dev-rate");
    await socket.untilPresence(["dev-rate"]);
    // Malformed, so nothing is relayed or answered: only the count
    // matters. Far more than the burst, in less time than it refills.
    for (let i = 0; i < 1000; i++) socket.ws.send("{}");
    expect((await socket.closed).code).toBe(CLOSE_RATE_LIMITED);
  });

  it("lets a dial storm's worth of asks through", async () => {
    const { socket } = await enrollAndConnect("acct-input-storm", "dev-storm");
    await enrollAndConnect("acct-input-storm", "dev-storm-peer");
    await socket.untilPresence(["dev-storm", "dev-storm-peer"]);
    // Two messages per peer of an account at its device cap.
    for (let i = 0; i < 2 * (MAX_ACCOUNT_DEVICES - 1); i++) {
      socket.send({ t: "relay", to: "dev-storm-peer", frame: `ask:${i}:x` });
    }
    socket.send({ t: "relay", to: "dev-gone", frame: "x" });
    expect(await socket.next()).toMatchObject({ t: "nack", to: "dev-gone" });
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
    // DeviceIdSchema ceiling of 200 characters with its key (a deviceId is
    // schema-bounded on enroll, so no real id exceeds it). Built with
    // the real encodeEnvelope so growth in the envelope shape cannot
    // silently outgrow this guard.
    const worstCase = encodeEnvelope({
      t: "presence",
      online: Array.from({ length: MAX_ONLINE_DEVICES }, () => ({
        deviceId: "x".repeat(200),
        publicKey: "k".repeat(43),
      })),
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
    expect(ticketAttempt.status).toBe(403);
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
    // This exercises the D1 existence gate at connect, not the ticket
    // purge. Mint a ticket, then delete the device row directly,
    // bypassing revoke's ticket purge, so the ticket record is still
    // present and unexpired at connect time. The object re-reads D1,
    // finds no device and rejects. This is the mint-concurrent-with-
    // revoke race: a ticket whose put landed after revoke's purge must
    // still not open a socket for a device whose D1 row is already gone.
    const { credential } = await enroll("acct-rev-d1", "dev-rev-d1");
    const { ticket } = await mintTicket(credential);
    // Delete the row out of band so the DO's ticket record survives and
    // only the D1 existence check can catch this.
    await env.DB.prepare("DELETE FROM devices WHERE device_id = ?")
      .bind("dev-rev-d1")
      .run();
    const socket = await openSocket(ticket);
    expect((await socket.closed).code).toBe(CLOSE_TICKET_REJECTED);
  });
});
