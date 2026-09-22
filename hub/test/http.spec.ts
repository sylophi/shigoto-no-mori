// The HTTP surface: enrollment, device listing, revocation, tickets
// and CORS. Runs inside workerd against real D1 and DO bindings, with
// the stub Clerk verifier from helpers.ts.
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  DeviceListResponseSchema,
  EnrollResponseSchema,
  HUB_ROUTES,
  MAX_ACCOUNT_DEVICES,
} from "../../shared/hub/protocol.ts";
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
  provisionRequest,
  updateRequest,
  revoke,
  revokeRequest,
  ticketRequest,
} from "./helpers.ts";

afterEach(closeAllSockets);

// The 17th device, for the enroll cap. A fresh Request per call, since
// a Request's body cannot be read twice.
function overCapRequest(): Request {
  return enrollRequest(`${TEST_TOKEN_PREFIX}acct-cap`, {
    deviceId: "dev-cap-extra",
    name: "One too many",
    platform: "darwin",
  });
}

function listRequest(credential: string): Request {
  return new Request(`${BASE}${HUB_ROUTES.listDevices.path}`, {
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
      kind: null,
      lastSeenAt: null,
      online: false,
    });
    // The credential authenticates against the device-tier endpoints.
    const list = await call(listRequest(credential));
    expect(list.status).toBe(200);
  });

  it("stores the kind a device reports, lists it, and refuses one outside the catalog", async () => {
    const { credential, device } = await enroll(
      "acct-kind",
      "dev-kind",
      "MacBook",
      "darwin",
      "laptop",
    );
    expect(device.kind).toBe("laptop");
    const listed = (await (await call(listRequest(credential))).json()) as {
      devices: { deviceId: string; kind: string | null }[];
    };
    expect(listed.devices.find((d) => d.deviceId === "dev-kind")?.kind).toBe(
      "laptop",
    );
    const bogus = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-kind`, {
        deviceId: "dev-kind-bogus",
        name: "Toaster",
        platform: "linux",
        kind: "toaster",
      }),
    );
    expect(bogus.status).toBe(400);
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

  it("caps devices per account by dropping the stalest one, never by locking the account out", async () => {
    const enrolled = [];
    for (let i = 0; i < MAX_ACCOUNT_DEVICES; i++) {
      // oxlint-disable-next-line no-await-in-loop -- eviction order is enroll order, so these have to land one at a time
      enrolled.push(await enroll("acct-cap", `dev-cap-${i}`));
    }
    // Re-enrolling is a rotation, not a new device, so nothing is
    // dropped for it.
    const rotated = await enroll("acct-cap", "dev-cap-1");
    expect(rotated.credential).not.toBe(enrolled[1].credential);
    expect((await call(listRequest(enrolled[0].credential))).status).toBe(200);
    // A new device over the cap takes the place of the stalest one,
    // whose credential dies with it (a revoke, so it reads as one).
    expect((await call(overCapRequest())).status).toBe(200);
    expect((await call(listRequest(enrolled[0].credential))).status).toBe(403);
    const listed = await call(listRequest(rotated.credential));
    const { devices } = (await listed.json()) as { devices: unknown[] };
    expect(devices).toHaveLength(MAX_ACCOUNT_DEVICES);
    // The cap is per account, so a neighbor is unaffected.
    await enroll("acct-cap-neighbor", "dev-cap-neighbor");
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
    expect((await call(listRequest(victim.credential))).status).toBe(403);
  });

  it("tells a revoked credential it was revoked on every credentialed route, and a garbage or rotated-away one nothing", async () => {
    const keeper = await enroll("acct-tomb", "dev-tomb-keeper");
    const victim = await enroll("acct-tomb", "dev-tomb-victim");
    expect((await revoke(keeper.credential, "dev-tomb-victim")).status).toBe(
      204,
    );
    // A device that was offline at the revoke presents the dead
    // credential later: a typed 403 the app signs out on, not the
    // plain 401 a garbage token gets.
    for (const request of [
      listRequest(victim.credential),
      ticketRequest(victim.credential),
      provisionRequest(victim.credential, 4321),
      updateRequest(victim.credential, "dev-tomb-victim", "Ghost"),
      revokeRequest(victim.credential, "dev-tomb-keeper"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one route at a time reads better than a Promise.all of five
      const response = await call(request);
      expect(response.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop
      expect(await response.json()).toMatchObject({ code: "device_revoked" });
    }
    expect((await call(listRequest("smdc_garbage"))).status).toBe(401);
    // A credential rotated away by a re-enroll is unknown, not revoked.
    const rotated = await enroll("acct-tomb", "dev-tomb-keeper");
    expect((await call(listRequest(keeper.credential))).status).toBe(401);
    expect((await call(listRequest(rotated.credential))).status).toBe(200);
    // A re-enrolled victim is back with a working credential, and the
    // old one still reads as revoked.
    const back = await enroll("acct-tomb", "dev-tomb-victim");
    expect((await call(listRequest(back.credential))).status).toBe(200);
    expect((await call(listRequest(victim.credential))).status).toBe(403);
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
        method: HUB_ROUTES.revokeDevice.method,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });
});

describe("PATCH /devices/:deviceId", () => {
  it("renames a device of the account and lists the new name", async () => {
    const self = await enroll("acct-ren", "dev-ren-self");
    const other = await enroll("acct-ren", "dev-ren-other");
    const response = await call(
      updateRequest(self.credential, "dev-ren-self", { name: "Studio Mac" }),
    );
    expect(response.status).toBe(204);
    const listed = (await (
      await call(listRequest(other.credential))
    ).json()) as { devices: { deviceId: string; name: string }[] };
    expect(
      listed.devices.find((d) => d.deviceId === "dev-ren-self")?.name,
    ).toBe("Studio Mac");
  });

  it("changes a device's kind alone, leaving its name, and refuses an empty patch", async () => {
    const self = await enroll("acct-kind-2", "dev-kind-2", "Mini", "darwin");
    expect(
      (
        await call(
          updateRequest(self.credential, "dev-kind-2", { kind: "mini" }),
        )
      ).status,
    ).toBe(204);
    const listed = (await (
      await call(listRequest(self.credential))
    ).json()) as {
      devices: { deviceId: string; name: string; kind: string }[];
    };
    expect(
      listed.devices.find((d) => d.deviceId === "dev-kind-2"),
    ).toMatchObject({ name: "Mini", kind: "mini" });
    expect(
      (await call(updateRequest(self.credential, "dev-kind-2", {}))).status,
    ).toBe(400);
    expect(
      (
        await call(
          updateRequest(self.credential, "dev-kind-2", { kind: "toaster" }),
        )
      ).status,
    ).toBe(400);
  });

  it("rejects a blank name and hides other accounts' devices behind 404", async () => {
    const self = await enroll("acct-ren-2", "dev-ren-2");
    const outsider = await enroll("acct-ren-outsider", "dev-ren-outsider");
    expect(
      (await call(updateRequest(self.credential, "dev-ren-2", { name: "" })))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          updateRequest(outsider.credential, "dev-ren-2", { name: "Taken" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(updateRequest("bogus", "dev-ren-2", { name: "Nope" })))
        .status,
    ).toBe(401);
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

  it("refuses to mint unsigned tickets when the signing key is unset", async () => {
    const { credential } = await enroll("acct-nokey", "dev-nokey");
    const response = await call(ticketRequest(credential), {
      ...env,
      TICKET_SIGNING_KEY: undefined,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "ticket signing is not configured",
    });
  });
});

// The limiters key on CF-Connecting-IP, which only the Cloudflare edge
// sets, so every other spec (no such header) runs unlimited and each
// rate limiting case spends its own made-up address.
async function statusesFrom(ip: string, count: number, path: string) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    // oxlint-disable-next-line no-await-in-loop -- the limiter counts in arrival order, so these have to land one at a time
    const response = await call(
      new Request(`${BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${DEVICE_CREDENTIAL_PREFIX}nobody`,
          "CF-Connecting-IP": ip,
          Upgrade: "websocket",
        },
      }),
    );
    statuses.push(response.status);
  }
  return statuses;
}

describe("rate limiting", () => {
  it("answers 429 with Retry-After once one address is over budget", async () => {
    const statuses = await statusesFrom(
      "203.0.113.10",
      310,
      HUB_ROUTES.listDevices.path,
    );
    expect(statuses.slice(0, 300).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const response = await call(
      new Request(`${BASE}${HUB_ROUTES.listDevices.path}`, {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({ error: "too many requests" });
    // The 429 still carries CORS, or a browser client could not read it.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // One caller's budget is not another's.
    const other = await statusesFrom(
      "203.0.113.11",
      1,
      HUB_ROUTES.listDevices.path,
    );
    expect(other).toEqual([401]);
  });

  it("holds the credential-free routes to the tighter budget", async () => {
    const statuses = await statusesFrom(
      "203.0.113.20",
      70,
      HUB_ROUTES.connect.path,
    );
    expect(statuses.slice(0, 60).every((status) => status === 403)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Enroll draws on the same budget, already spent above.
    const response = await call(
      new Request(`${BASE}${HUB_ROUTES.enroll.path}`, {
        method: HUB_ROUTES.enroll.method,
        headers: { "CF-Connecting-IP": "203.0.113.20" },
      }),
    );
    expect(response.status).toBe(429);
  });
});

describe("cors", () => {
  it("serves any browser origin, authenticating from the bearer alone", async () => {
    const response = await call(
      new Request(`${BASE}${HUB_ROUTES.listDevices.path}`, {
        headers: { Origin: "https://app.example" },
      }),
    );
    // 401 (no credential), never 403: the origin is not what decides.
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers the preflight a bearer request triggers", async () => {
    const preflight = await call(
      new Request(`${BASE}${HUB_ROUTES.enroll.path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5190",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
  });

  it("never allows credentials, so no cookie rides a cross-origin call", async () => {
    const response = await call(
      new Request(`${BASE}${HUB_ROUTES.listDevices.path}`, {
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(null);
  });
});
