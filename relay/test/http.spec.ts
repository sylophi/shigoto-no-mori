// The HTTP surface: enrollment, device listing, revocation, tickets
// and the origin gate. Runs inside workerd against real D1 and DO
// bindings, with the stub Clerk verifier from helpers.ts.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceListResponseSchema,
  EnrollResponseSchema,
  RELAY_ROUTES,
} from "../../shared/relay/protocol.ts";
import {
  DEVICE_CREDENTIAL_PREFIX,
  TICKET_PREFIX,
  TICKET_TTL_MS,
} from "../src/ticket.ts";
import {
  BASE,
  TEST_TOKEN_PREFIX,
  call,
  closeAllSockets,
  enroll,
  enrollAndConnect,
  enrollRequest,
  mintTicket,
  revoke,
  ticketRequest,
} from "./helpers.ts";

afterEach(closeAllSockets);

function listRequest(credential: string): Request {
  return new Request(`${BASE}${RELAY_ROUTES.listDevices.path}`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

describe("POST /devices/enroll", () => {
  it("enrolls a device and returns the raw credential exactly once", async () => {
    const { credential, device } = await enroll(
      "acct-enroll",
      "dev-enroll",
      "MacBook",
      "darwin",
    );
    expect(credential.startsWith(DEVICE_CREDENTIAL_PREFIX)).toBe(true);
    expect(device).toMatchObject({
      deviceId: "dev-enroll",
      name: "MacBook",
      platform: "darwin",
      lastSeenAt: null,
      online: false,
    });
    // The credential authenticates against the device-tier endpoints.
    const list = await call(listRequest(credential));
    expect(list.status).toBe(200);
  });

  it("rejects a bad login token with 401", async () => {
    const response = await call(
      enrollRequest("not-a-clerk-token", {
        deviceId: "dev-bad-token",
        name: "X",
        platform: "linux",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid login token" });
  });

  it("rejects a malformed body with 400", async () => {
    const response = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-badbody`, { deviceId: "" }),
    );
    expect(response.status).toBe(400);
  });

  it("re-enrolling rotates the credential and invalidates the old one", async () => {
    const first = await enroll("acct-rotate", "dev-rotate");
    const second = await enroll(
      "acct-rotate",
      "dev-rotate",
      "Renamed",
      "linux",
    );
    expect(second.credential).not.toBe(first.credential);
    expect(second.device.name).toBe("Renamed");
    const oldAuth = await call(listRequest(first.credential));
    expect(oldAuth.status).toBe(401);
    const newAuth = await call(listRequest(second.credential));
    expect(newAuth.status).toBe(200);
  });

  it("rejects the same deviceId under a different account with 409", async () => {
    await enroll("acct-conflict-a", "dev-conflict");
    const response = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-conflict-b`, {
        deviceId: "dev-conflict",
        name: "Thief",
        platform: "win32",
      }),
    );
    expect(response.status).toBe(409);
  });

  it("a cross-account race cannot bind one account's credential to the other's device", async () => {
    // Two accounts enroll the same deviceId at once. The SQL account
    // guard on the upsert means exactly one wins the row. The loser
    // gets a 409 and no credential, so it can never authenticate as the
    // winner. Before the guard, the loser's credential could bind to
    // the winner's row (a cross-account takeover).
    const deviceId = "dev-race";
    const [ra, rb] = await Promise.all([
      call(
        enrollRequest(`${TEST_TOKEN_PREFIX}acct-race-a`, {
          deviceId,
          name: "A",
          platform: "darwin",
        }),
      ),
      call(
        enrollRequest(`${TEST_TOKEN_PREFIX}acct-race-b`, {
          deviceId,
          name: "B",
          platform: "linux",
        }),
      ),
    ]);
    expect([ra.status, rb.status].toSorted()).toEqual([200, 409]);
    const winner = ra.status === 200 ? ra : rb;
    const loser = ra.status === 200 ? rb : ra;
    expect(await loser.json()).toMatchObject({ error: expect.any(String) });
    // The winner's credential authenticates and lists exactly its own
    // device, never a foreign account's.
    const winnerBody = EnrollResponseSchema.parse(await winner.json());
    const list = await call(listRequest(winnerBody.credential));
    expect(list.status).toBe(200);
    const body = DeviceListResponseSchema.parse(await list.json());
    expect(body.devices.map((device) => device.deviceId)).toEqual([deviceId]);
  });

  it("rejects an over-long deviceId with 400", async () => {
    const response = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-longid`, {
        deviceId: "d".repeat(300),
        name: "X",
        platform: "linux",
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /devices", () => {
  it("lists only the caller's account's devices, with presence", async () => {
    const a1 = await enroll("acct-list-a", "dev-list-a1");
    await enroll("acct-list-a", "dev-list-a2");
    await enroll("acct-list-b", "dev-list-b1");
    // Bring a2 online so the presence flag has something to show.
    const { socket } = await enrollAndConnect(
      "acct-list-a",
      "dev-list-a2-online",
    );
    await socket.untilPresence(["dev-list-a2-online"]);
    const response = await call(listRequest(a1.credential));
    expect(response.status).toBe(200);
    const body = DeviceListResponseSchema.parse(await response.json());
    const byId = new Map(
      body.devices.map((device) => [device.deviceId, device]),
    );
    expect([...byId.keys()].toSorted()).toEqual([
      "dev-list-a1",
      "dev-list-a2",
      "dev-list-a2-online",
    ]);
    expect(byId.get("dev-list-a1")?.online).toBe(false);
    expect(byId.get("dev-list-a2-online")?.online).toBe(true);
  });

  it("rejects an unknown credential with 401", async () => {
    const response = await call(
      listRequest(`${DEVICE_CREDENTIAL_PREFIX}bogus`),
    );
    expect(response.status).toBe(401);
  });
});

describe("DELETE /devices/:deviceId", () => {
  it("revokes a device and kills its credential", async () => {
    const keeper = await enroll("acct-del", "dev-del-keeper");
    const victim = await enroll("acct-del", "dev-del-victim");
    const response = await revoke(keeper.credential, "dev-del-victim");
    expect(response.status).toBe(204);
    expect((await call(listRequest(victim.credential))).status).toBe(401);
  });

  it("hides other accounts' devices behind 404", async () => {
    const outsider = await enroll("acct-del-outsider", "dev-del-outsider");
    const target = await enroll("acct-del-target", "dev-del-target");
    const response = await revoke(outsider.credential, "dev-del-target");
    expect(response.status).toBe(404);
    // The target device is untouched: a re-enroll is a rotation of the
    // existing row, not a fresh row, so createdAt is preserved.
    const again = await enroll("acct-del-target", "dev-del-target");
    expect(again.device.createdAt).toBe(target.device.createdAt);
  });

  it("returns a 4xx JSON error for a malformed percent-escape, not a 500", async () => {
    // decodeURIComponent throws URIError on a lone percent. With no
    // Authorization header this path is reachable unauthenticated, so
    // it must answer with the { error } shape and a 400, never leak a
    // workerd text 500.
    const response = await call(
      new Request(`${BASE}/devices/%`, {
        method: RELAY_ROUTES.revokeDevice.method,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });
});

describe("POST /tickets", () => {
  it("mints a prefixed ticket with the default TTL", async () => {
    const { credential } = await enroll("acct-ticket", "dev-ticket");
    const ticket = await mintTicket(credential);
    expect(ticket.ticket.startsWith(TICKET_PREFIX)).toBe(true);
    expect(ticket.expiresInMs).toBe(TICKET_TTL_MS);
  });

  it("rejects an unknown credential with 401", async () => {
    const response = await call(
      ticketRequest(`${DEVICE_CREDENTIAL_PREFIX}nope`),
    );
    expect(response.status).toBe(401);
  });
});

describe("origin gate", () => {
  it("rejects any browser origin by default", async () => {
    const response = await call(
      new Request(`${BASE}${RELAY_ROUTES.listDevices.path}`, {
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("allows exactly the configured web origin, with CORS headers", async () => {
    const webEnv = { ...env, ALLOWED_WEB_ORIGIN: "https://app.example" };
    const allowed = await call(
      new Request(`${BASE}${RELAY_ROUTES.listDevices.path}`, {
        headers: { Origin: "https://app.example" },
      }),
      webEnv,
    );
    // 401 (no credential), not 403: the origin gate let it through.
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example",
    );
    const denied = await call(
      new Request(`${BASE}${RELAY_ROUTES.listDevices.path}`, {
        headers: { Origin: "https://other.example" },
      }),
      webEnv,
    );
    expect(denied.status).toBe(403);
  });
});
