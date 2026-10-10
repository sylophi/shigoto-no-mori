// The HTTP surface: enrollment, device listing, revocation, tickets
// and CORS. Runs inside workerd against real D1 and DO bindings, with
// the stub Clerk verifier from helpers.ts.
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  HUB_PROTOCOL_FLOOR,
  PROTOCOL_HEADER,
} from "@shigomori/contracts/hubApi";
import {
  DeviceListResponseSchema,
  EnrollResponseSchema,
  MAX_ACCOUNT_DEVICES,
} from "@shigomori/contracts/hubProtocol";
import {
  DEVICE_CREDENTIAL_PREFIX,
  TICKET_PREFIX,
  TICKET_TTL_MS,
} from "../src/ticket.ts";
import type { Env } from "../src/env.ts";
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
    icon: "laptop",
  });
}

function listRequest(credential: string): Request {
  return new Request(`${BASE}/devices`, {
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
      icon: "laptop",
      lastSeenAt: null,
      online: false,
    });
    // The credential authenticates against the device-tier endpoints.
    const list = await call(listRequest(credential));
    expect(list.status).toBe(200);
  });

  it("stores the icon a device reports, lists it, and passes one outside the catalog through as sent", async () => {
    const { credential, device } = await enroll(
      "acct-icon",
      "dev-icon",
      "MacBook",
      "darwin",
      "laptop",
    );
    expect(device.icon).toBe("laptop");
    const listed = (await (await call(listRequest(credential))).json()) as {
      devices: { deviceId: string; icon: string }[];
    };
    expect(listed.devices.find((d) => d.deviceId === "dev-icon")?.icon).toBe(
      "laptop",
    );
    // An icon this Worker's catalog lacks (a newer client's) must not
    // block the enroll: it is stored and listed as sent, and each
    // reader maps it to the catalog it knows (DeviceInfoSchema).
    const newer = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-icon`, {
        deviceId: "dev-icon-newer",
        name: "Toaster",
        platform: "linux",
        icon: "toaster",
      }),
    );
    expect(newer.status).toBe(200);
    const again = (await (await call(listRequest(credential))).json()) as {
      devices: { deviceId: string; icon: string }[];
    };
    expect(
      again.devices.find((d) => d.deviceId === "dev-icon-newer")?.icon,
    ).toBe("toaster");
    expect(
      Schema.decodeUnknownSync(DeviceListResponseSchema)(again).devices.find(
        (d) => d.deviceId === "dev-icon-newer",
      )?.icon,
    ).toBe("desktop");
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
    expect(await response.json()).toEqual({ _tag: "HubLoginRejectedError" });
  });

  it("rejects a malformed body with 400", async () => {
    const response = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-badbody`, { deviceId: "" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an enroll that names no icon with 400", async () => {
    const response = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-noicon`, {
        deviceId: "dev-noicon",
        name: "Iconless",
        platform: "darwin",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an enroll that names no public key, or a malformed one, with 400", async () => {
    for (const publicKey of [undefined, "too-short", "=".repeat(43)]) {
      // oxlint-disable-next-line no-await-in-loop -- one request per case, in turn
      const response = await call(
        enrollRequest(`${TEST_TOKEN_PREFIX}acct-nokey`, {
          deviceId: "dev-nokey",
          name: "Keyless",
          platform: "darwin",
          icon: "laptop",
          publicKey,
        }),
      );
      expect(response.status).toBe(400);
    }
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
    const [stalest, second] = enrolled;
    if (stalest === undefined || second === undefined) {
      throw new Error("the cap test enrolls at least two devices");
    }
    expect(rotated.credential).not.toBe(second.credential);
    expect((await call(listRequest(stalest.credential))).status).toBe(200);
    // A new device over the cap takes the place of the stalest one,
    // whose credential dies with it (a revoke, so it reads as one).
    expect((await call(overCapRequest())).status).toBe(200);
    expect((await call(listRequest(stalest.credential))).status).toBe(403);
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
        icon: "desktop",
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
          icon: "laptop",
        }),
      ),
      call(
        enrollRequest(`${TEST_TOKEN_PREFIX}acct-race-b`, {
          deviceId,
          name: "B",
          platform: "linux",
          icon: "laptop",
        }),
      ),
    ]);
    expect([ra.status, rb.status].toSorted()).toEqual([200, 409]);
    const winner = ra.status === 200 ? ra : rb;
    const loser = ra.status === 200 ? rb : ra;
    expect(await loser.json()).toEqual({
      _tag: "HubDeviceEnrolledElsewhereError",
    });
    // The winner's credential authenticates and lists exactly its own
    // device, never a foreign account's.
    const winnerBody = Schema.decodeUnknownSync(EnrollResponseSchema)(
      await winner.json(),
    );
    const list = await call(listRequest(winnerBody.credential));
    expect(list.status).toBe(200);
    const body = Schema.decodeUnknownSync(DeviceListResponseSchema)(
      await list.json(),
    );
    expect(body.devices.map((device) => device.deviceId)).toEqual([deviceId]);
  });

  it("rejects an over-long deviceId with 400", async () => {
    const response = await call(
      enrollRequest(`${TEST_TOKEN_PREFIX}acct-longid`, {
        deviceId: "d".repeat(300),
        name: "X",
        platform: "linux",
        icon: "laptop",
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
    const body = Schema.decodeUnknownSync(DeviceListResponseSchema)(
      await response.json(),
    );
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
      // oxlint-disable-next-line no-await-in-loop -- the same one-route-at-a-time loop
      expect(await response.json()).toEqual({ _tag: "HubDeviceRevokedError" });
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

  it("answers a malformed percent-escape with a 4xx, not a 500", async () => {
    // A lone percent cannot be decoded into a device id, and with no
    // Authorization header this path is reachable unauthenticated, so
    // it must miss the route rather than throw.
    const response = await call(
      new Request(`${BASE}/devices/%`, {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(404);
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

  it("changes a device's icon alone, leaving its name, and refuses an empty patch", async () => {
    const self = await enroll("acct-icon-2", "dev-icon-2", "Mini", "darwin");
    expect(
      (
        await call(
          updateRequest(self.credential, "dev-icon-2", { icon: "mini" }),
        )
      ).status,
    ).toBe(204);
    const listed = (await (
      await call(listRequest(self.credential))
    ).json()) as {
      devices: { deviceId: string; name: string; icon: string }[];
    };
    expect(
      listed.devices.find((d) => d.deviceId === "dev-icon-2"),
    ).toMatchObject({ name: "Mini", icon: "mini" });
    expect(
      (await call(updateRequest(self.credential, "dev-icon-2", {}))).status,
    ).toBe(400);
    expect(
      (await call(updateRequest(self.credential, "dev-icon-2", { icon: "" })))
        .status,
    ).toBe(400);
  });

  it("changes another device's icon from a device of the same account", async () => {
    const self = await enroll("acct-icon-3", "dev-icon-3-self");
    const other = await enroll("acct-icon-3", "dev-icon-3-other");
    expect(
      (
        await call(
          updateRequest(self.credential, "dev-icon-3-other", { icon: "cat" }),
        )
      ).status,
    ).toBe(204);
    const listed = (await (
      await call(listRequest(other.credential))
    ).json()) as { devices: { deviceId: string; icon: string }[] };
    expect(
      listed.devices.find((d) => d.deviceId === "dev-icon-3-other")?.icon,
    ).toBe("cat");
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
      _tag: "HubTicketSigningUnconfiguredError",
    });
  });
});

// A limiter whose window never rolls over. The simulated ratelimits
// binding counts in windows aligned to the wall clock, so a burst that
// crosses a minute boundary starts again from zero and never reaches
// the limit.
function frozenLimiter(limit: number): RateLimit {
  const counts = new Map<string, number>();
  return {
    async limit({ key }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
}

// Made-up budgets, fresh for each case. The cases cover which budget
// each route draws on and what an over-budget caller gets back, not the
// sizes in wrangler.jsonc.
const BUDGET = 5;
const OPEN_BUDGET = 2;

function limitedEnv(): Env {
  return {
    ...env,
    RATE_LIMIT: frozenLimiter(BUDGET),
    RATE_LIMIT_OPEN: frozenLimiter(OPEN_BUDGET),
  };
}

// The limiters key on CF-Connecting-IP, which only the Cloudflare edge
// sets, so every other spec (no such header) runs unlimited.
async function statusesFrom(
  testEnv: Env,
  ip: string,
  count: number,
  path: string,
) {
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
      testEnv,
    );
    statuses.push(response.status);
  }
  return statuses;
}

describe("the version floor", () => {
  it("turns away a build below the floor, or one naming none, with the sentence a v2 build shows", async () => {
    const { credential } = await enroll("acct-floor", "dev-floor");
    for (const version of ["", "3", "not a number"]) {
      const request = new Request(`${BASE}/devices`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          [PROTOCOL_HEADER]: version,
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- three cases, order does not matter
      const response = await call(request);
      expect(response.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await response.json()).toMatchObject({
        _tag: "HubUpdateRequiredError",
        floor: HUB_PROTOCOL_FLOOR,
        error: expect.stringContaining("Update it"),
      });
    }
  });

  it("refuses an old build's enroll before its login is checked", async () => {
    const response = await call(
      new Request(`${BASE}/devices/enroll`, {
        method: "POST",
        headers: { [PROTOCOL_HEADER]: "" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      _tag: "HubUpdateRequiredError",
    });
  });

  it("serves a build at or above the floor", async () => {
    const { credential } = await enroll("acct-floor-ok", "dev-floor-ok");
    const response = await call(
      new Request(`${BASE}/devices`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          [PROTOCOL_HEADER]: String(HUB_PROTOCOL_FLOOR + 1),
        },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("rate limiting", () => {
  // A missing binding would fail open in rateLimited, so the cases below,
  // which stand in their own limiters, would never notice it.
  it("binds both budgets from wrangler.jsonc", async () => {
    for (const limiter of [env.RATE_LIMIT, env.RATE_LIMIT_OPEN]) {
      // oxlint-disable-next-line no-await-in-loop -- two calls, order does not matter
      expect(await limiter.limit({ key: "203.0.113.30" })).toEqual({
        success: true,
      });
    }
  });

  it("answers 429 with Retry-After once one address is over budget", async () => {
    const testEnv = limitedEnv();
    const statuses = await statusesFrom(
      testEnv,
      "203.0.113.10",
      BUDGET + 1,
      "/devices",
    );
    expect(statuses.slice(0, BUDGET).every((status) => status === 401)).toBe(
      true,
    );
    expect(statuses.at(-1)).toBe(429);
    const response = await call(
      new Request(`${BASE}/devices`, {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      testEnv,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    // The 429 still carries CORS, or a browser client could not read it.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // One caller's budget is not another's.
    const other = await statusesFrom(testEnv, "203.0.113.11", 1, "/devices");
    expect(other).toEqual([401]);
  });

  it("holds the credential-free routes to the tighter budget", async () => {
    const testEnv = limitedEnv();
    const statuses = await statusesFrom(
      testEnv,
      "203.0.113.20",
      OPEN_BUDGET + 1,
      "/connect",
    );
    expect(
      statuses.slice(0, OPEN_BUDGET).every((status) => status === 403),
    ).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Enroll draws on the same budget, already spent above.
    const response = await call(
      new Request(`${BASE}/devices/enroll`, {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.20" },
      }),
      testEnv,
    );
    expect(response.status).toBe(429);
  });
});

describe("cors", () => {
  it("serves any browser origin, authenticating from the bearer alone", async () => {
    const response = await call(
      new Request(`${BASE}/devices`, {
        headers: { Origin: "https://app.example" },
      }),
    );
    // 401 (no credential), never 403: the origin is not what decides.
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers the preflight a bearer request triggers", async () => {
    const preflight = await call(
      new Request(`${BASE}/devices/enroll`, {
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
    // The web client names its protocol in a header of its own.
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      PROTOCOL_HEADER,
    );
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
  });

  it("never allows credentials, so no cookie rides a cross-origin call", async () => {
    const response = await call(
      new Request(`${BASE}/devices`, {
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(null);
  });
});
