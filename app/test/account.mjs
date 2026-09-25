// Durable proof for the electron-free account layer (main/core/account/*,
// shared/account/*). Drives the pure modules end to end with stubs and
// asserts the security and wire-shape invariants without electron,
// without a browser and without the network: the hub client's
// route/method/auth-tier discipline against the shared schemas, the
// credential store's encrypt and plaintext-fallback round trips plus
// its corrupt/missing tolerance, deriveAccountId's tolerance of a
// malformed token, the .env.local parser and the three-layer
// file/baked/process.env merge precedence, the setDeviceName and enroll
// contract bounds, and the shape guarantee that the device credential
// never appears in a renderer-visible object.
//
// Sign-in itself is Clerk's embedded UI plus the @clerk/electron
// bridge. The pure seam this layer owns starts at the session token
// the renderer hands account:enroll, whose orchestration
// (shared/account/enroll.ts, driven by both shells) is proved here.
// The other thing it cannot cover is the safeStorage cipher round trip
// itself: that is an OS-keychain, electron-only seam, so the store here
// runs against injected cipher stubs and the real encryption path is
// exercised by hand.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// and @shared imports resolve. Run: pnpm test account.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isConfigured,
  mergeServiceEnv,
  parseDotenv,
  resolveServiceConfig,
} from "../shared/account/serviceConfig.ts";
import {
  effectiveDeviceIcon,
  enrollDevice,
  retryParkedRevoke,
  signOutDevice,
  syncHubDevice,
  updateDevice,
} from "../shared/account/enroll.ts";
import {
  HubRequestError,
  TunnelProvisionDeniedError,
  createAccountService,
  isHubRefusal,
} from "../shared/account/service.ts";
import { deriveAccountId } from "../shared/account/token.ts";
import { createAccountStore } from "../main/core/account/credentialStore.ts";
import { createAccountStore as createCoreAccountStore } from "../shared/account/credentialStore.ts";
import { shortHostname } from "../main/core/account/defaultDeviceName.ts";
import {
  appleProductNameOf,
  deviceShapeFromAppleModel,
  deviceShapeFromDmi,
} from "../main/core/account/defaultDeviceIcon.ts";
import {
  AccountStatusSchema,
  accountContract,
} from "@shared/ipc/modules/account";
import { DeviceInfoSchema, HUB_ROUTES } from "@shared/hub/protocol";
import { fakeSessionJwt, makeProof } from "./lib/checkKit.mjs";

// A resolved config that isConfigured accepts, for the flows that need
// one. The hub URL is never dialled: fetch is always stubbed.
const CONFIG = resolveServiceConfig({
  SM_DEVICE_HUB_URL: "https://hub.test",
  SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
});

// base64url without padding, for the malformed-token cases below.
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// A fetch stub that records every call and answers via the responder.
function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url), init ?? {});
  };
  return { fetchImpl, calls };
}

// An account service over a recording fetch stub, answering via the
// responder, plus the calls it recorded.
function stubService(responder, baseUrl = "https://hub.test") {
  const { fetchImpl, calls } = recordingFetch(responder);
  return { service: createAccountService({ baseUrl, fetchImpl }), calls };
}

const json = (body, status = 200) => Response.json(body, { status });

// The plaintext cipher stub: a keychain-less machine's fallback, where
// the store writes enc:false and the round trip is the identity.
const PLAINTEXT_CIPHER = {
  available: false,
  encrypt: (s) => s,
  decrypt: (p) => p,
};

// The one device the device hub stubs report.
const DEVICE = {
  deviceId: "device-uuid",
  name: "Test Mac",
  platform: "darwin",
  icon: "laptop",
  createdAt: 1_700_000_000_000,
  lastSeenAt: null,
  online: true,
};

// A registry listing holding a peer and this device, wearing `icon`
// and `name`.
const ownRowListing = (icon, name = "d") => [
  { ...DEVICE, deviceId: "peer-uuid", platform: "linux", icon: "server" },
  { ...DEVICE, icon, name },
];

const dmi = (chassisType, vendor = null, product = null) =>
  deviceShapeFromDmi({ chassisType, vendor, product });

const { check, done, fail } = makeProof("account layer proof");

async function main() {
  console.log("account layer proof\n");

  await check(
    "config: isConfigured is false until every required field is set",
    () => {
      assert.equal(isConfigured(CONFIG), true);
      assert.equal(isConfigured(resolveServiceConfig({})), false);
      const missingKey = resolveServiceConfig({
        SM_DEVICE_HUB_URL: "https://hub.test",
      });
      assert.equal(isConfigured(missingKey), false);
      const missingHub = resolveServiceConfig({
        SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
      });
      assert.equal(isConfigured(missingHub), false);
    },
  );

  await check(
    "service: enroll hits the enroll route with the session-token bearer and an EnrollRequest body",
    async () => {
      const { service, calls } = stubService(() =>
        json({ credential: "device-credential", device: DEVICE }),
      );
      const result = await service.enroll("session-token", {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
        icon: "laptop",
      });
      assert.equal(result.credential, "device-credential");
      assert.deepEqual(result.device, DEVICE);
      assert.equal(calls[0].url, "https://hub.test" + HUB_ROUTES.enroll.path);
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.authorization, "Bearer session-token");
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body, {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
        icon: "laptop",
      });
    },
  );

  await check(
    "service: listDevices GETs the devices route under the credential bearer",
    async () => {
      const { service, calls } = stubService(() => json({ devices: [DEVICE] }));
      const devices = await service.listDevices("device-credential");
      assert.deepEqual(devices, [DEVICE]);
      assert.equal(
        calls[0].url,
        "https://hub.test" + HUB_ROUTES.listDevices.path,
      );
      assert.equal(calls[0].init.method, "GET");
      assert.equal(
        calls[0].init.headers.authorization,
        "Bearer device-credential",
      );
    },
  );

  await check(
    "service: update PATCHes the per-device route with the name and/or icon and tolerates a 204",
    async () => {
      const { service, calls } = stubService(
        () => new Response(null, { status: 204 }),
      );
      await service.update("device-credential", "this device/id", {
        name: "Studio",
      });
      assert.equal(
        calls[0].url,
        "https://hub.test" + HUB_ROUTES.updateDevice.path("this device/id"),
      );
      assert.equal(calls[0].init.method, "PATCH");
      assert.deepEqual(JSON.parse(calls[0].init.body), { name: "Studio" });
      assert.equal(
        calls[0].init.headers.authorization,
        "Bearer device-credential",
      );
      await service.update("device-credential", "id", { icon: "mini" });
      assert.deepEqual(JSON.parse(calls[1].init.body), { icon: "mini" });
      await assert.rejects(
        () => service.update("device-credential", "id", { name: "" }),
        "a blank name was sent to the hub",
      );
      await assert.rejects(
        () => service.update("device-credential", "id", {}),
        "an empty patch was sent to the hub",
      );
      await assert.rejects(
        () => service.update("device-credential", "id", { icon: "" }),
        "a blank icon was sent to the hub",
      );
    },
  );

  await check(
    "service: revoke DELETEs the per-device route and tolerates a 204",
    async () => {
      const { service, calls } = stubService(
        () => new Response(null, { status: 204 }),
      );
      await service.revoke("device-credential", "other device/id");
      assert.equal(
        calls[0].url,
        "https://hub.test" + HUB_ROUTES.revokeDevice.path("other device/id"),
      );
      assert.match(
        calls[0].url,
        /other%20device%2Fid$/,
        "deviceId not encoded",
      );
      assert.equal(calls[0].init.method, "DELETE");
      assert.equal(
        calls[0].init.headers.authorization,
        "Bearer device-credential",
      );
    },
  );

  await check(
    "service: mintTicket POSTs the tickets route under the credential bearer",
    async () => {
      const { service, calls } = stubService(() =>
        json({ ticket: "the-ticket", expiresInMs: 30_000 }),
      );
      const ticket = await service.mintTicket("device-credential");
      assert.equal(ticket.ticket, "the-ticket");
      assert.equal(
        calls[0].url,
        "https://hub.test" + HUB_ROUTES.mintTicket.path,
      );
      assert.equal(calls[0].init.method, "POST");
      assert.equal(
        calls[0].init.headers.authorization,
        "Bearer device-credential",
      );
    },
  );

  await check(
    "service: the auth tier differs, enroll under the session token and the rest under the credential",
    async () => {
      const responder = (url) => {
        if (url.endsWith(HUB_ROUTES.enroll.path)) {
          return json({ credential: "device-credential", device: DEVICE });
        }
        return json({ devices: [DEVICE] });
      };
      const { service, calls } = stubService(responder);
      await service.enroll("session-token", {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
        icon: "laptop",
      });
      await service.listDevices("device-credential");
      const enrollAuth = calls[0].init.headers.authorization;
      const listAuth = calls[1].init.headers.authorization;
      assert.equal(enrollAuth, "Bearer session-token");
      assert.equal(listAuth, "Bearer device-credential");
      assert.notEqual(enrollAuth, listAuth, "enroll and list share a bearer");
    },
  );

  await check(
    "service: a non-2xx with an ErrorBody throws the device hub's error message",
    async () => {
      const { service } = stubService(() =>
        json({ error: "device revoked" }, 403),
      );
      await assert.rejects(
        () => service.listDevices("device-credential"),
        /device revoked/,
      );
    },
  );

  await check(
    "service: a rate-limited tunnel provision stays retryable, any other 4xx is a denial",
    async () => {
      const provisionWith = (status) => {
        const { service } = stubService(() =>
          json({ error: "refused" }, status),
        );
        return service.provisionTunnel("device-credential", 4000);
      };
      await assert.rejects(
        () => provisionWith(401),
        (error) => error instanceof TunnelProvisionDeniedError,
      );
      // The hub's rate limiter answers 429, which a later attempt can
      // turn into a success, so it must not park the tunnel runner the
      // way a denial does.
      await assert.rejects(
        () => provisionWith(429),
        (error) =>
          error instanceof HubRequestError &&
          error.status === 429 &&
          !isHubRefusal(error),
      );
    },
  );

  // An in-memory store over the shared core, the seam both shells'
  // enroll/sign-out orchestration is driven through.
  // `initial` seeds the stored document, and raw() reads it back.
  const memoryStore = (initial = null) => {
    let stored = initial;
    const store = createCoreAccountStore({
      storage: {
        readRaw: () => stored,
        writeRaw: (text) => {
          stored = text;
        },
        removeRaw: () => {
          stored = null;
        },
      },
      cipher: PLAINTEXT_CIPHER,
    });
    return Object.assign(store, { raw: () => JSON.parse(stored) });
  };

  await check(
    "enroll flow: enrollDevice stores the credential with the derived accountId under the stored-or-fallback device name, and an unconfigured build rejects before any fetch",
    async () => {
      const { service, calls } = stubService(
        () => json({ credential: "cred-1", device: DEVICE }),
        CONFIG.hubUrl,
      );
      const store = memoryStore();
      await enrollDevice(
        {
          config: CONFIG,
          service,
          store,
          deviceId: "device-uuid",
          fallbackDeviceName: "Fallback Mac",
          platform: "darwin",
          detectedIcon: "laptop",
        },
        fakeSessionJwt("user_abc"),
      );
      assert.deepEqual(store.read(), {
        credential: "cred-1",
        accountId: "user_abc",
        deviceName: "Fallback Mac",
        // What it enrolled under is where the hub starts.
        hubName: "Fallback Mac",
        hubIcon: "laptop",
      });
      // With no pick stored, the device enrolls under what it detected.
      assert.equal(JSON.parse(calls[0].init.body).icon, "laptop");
      // A stored name survives re-enrollment. The fallback is only for
      // a first sign-in. So does a stored icon pick, over the detection.
      store.write({
        ...store.read(),
        deviceName: "Renamed",
        deviceIcon: "server",
      });
      await enrollDevice(
        {
          config: CONFIG,
          service,
          store,
          deviceId: "device-uuid",
          fallbackDeviceName: "Fallback Mac",
          platform: "darwin",
          detectedIcon: "laptop",
        },
        fakeSessionJwt("user_abc"),
      );
      assert.equal(store.read().deviceName, "Renamed");
      assert.equal(store.read().deviceIcon, "server");
      assert.equal(JSON.parse(calls[1].init.body).icon, "server");
      // The name outlives a sign-out into the next enrollment, and a
      // parked revoke from that sign-out is delivered only when the hub
      // refuses the enroll for it (a 409: the device is still on the
      // old account), after which the enroll is tried once more.
      store.park({
        credential: "cred-1",
        accountId: "user_abc",
        deviceName: "Renamed",
        deviceIcon: "server",
      });
      assert.equal(store.read(), null);
      let refusals = 0;
      const { fetchImpl: conflicting, calls: conflictCalls } = recordingFetch(
        (url, init) => {
          if (init.method === "DELETE")
            return new Response(null, { status: 204 });
          refusals += 1;
          return refusals === 1
            ? json({ error: "enrolled under a different account" }, 409)
            : json({ credential: "cred-2", device: DEVICE });
        },
      );
      await enrollDevice(
        {
          config: CONFIG,
          service: createAccountService({
            baseUrl: CONFIG.hubUrl,
            fetchImpl: conflicting,
          }),
          store,
          deviceId: "device-uuid",
          fallbackDeviceName: "Fallback Mac",
          platform: "darwin",
          detectedIcon: "laptop",
        },
        fakeSessionJwt("user_other"),
      );
      assert.deepEqual(
        conflictCalls.map((c) => c.init.method),
        ["POST", "DELETE", "POST"],
        "the parked revoke did not go between the refused and the retried enroll",
      );
      assert.equal(
        conflictCalls[1].init.headers.authorization,
        "Bearer cred-1",
      );
      assert.deepEqual(store.read(), {
        credential: "cred-2",
        accountId: "user_other",
        deviceName: "Renamed",
        deviceIcon: "server",
        hubName: "Renamed",
        hubIcon: "server",
      });
      assert.equal(store.readParked(), null);

      const before = calls.length;
      await assert.rejects(
        () =>
          enrollDevice(
            {
              config: resolveServiceConfig({}),
              service,
              store,
              deviceId: "device-uuid",
              fallbackDeviceName: "Fallback Mac",
              platform: "darwin",
              detectedIcon: "laptop",
            },
            fakeSessionJwt("user_abc"),
          ),
        /not configured/,
      );
      assert.equal(calls.length, before, "an unconfigured enroll fetched");
    },
  );

  await check(
    "device sync: syncHubDevice adopts a name or icon changed on another device, the detected icon as no pick, and never over a change or sign-out that landed during the read",
    async () => {
      const { fetchImpl, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const store = memoryStore();
      const deps = {
        service: createAccountService({ baseUrl: CONFIG.hubUrl, fetchImpl }),
        store,
        deviceId: "device-uuid",
        detectedIcon: "laptop",
      };
      const sync = (listing, listedUnder = store.read()) =>
        syncHubDevice(deps, listedUnder, listing);
      store.write({ credential: "c", accountId: "a", deviceName: "d" });
      // A record from before the hub fields takes the listing as its
      // baseline.
      assert.equal(sync(ownRowListing("laptop")), false);
      assert.equal(store.read().hubName, "d");
      assert.equal(store.read().hubIcon, "laptop");
      assert.equal(sync(ownRowListing("cat")), true);
      assert.equal(store.read().deviceIcon, "cat");
      assert.equal(store.read().hubIcon, "cat");
      assert.equal(sync(ownRowListing("cat", "Studio")), true);
      assert.equal(store.read().deviceName, "Studio");
      assert.equal(store.read().hubName, "Studio");
      // The detected icon drops the pick outright.
      assert.equal(sync(ownRowListing("laptop", "Studio")), true);
      assert.equal(store.read().deviceIcon, undefined);
      // A listing without this device changes nothing.
      assert.equal(sync(ownRowListing("cat").slice(0, 1)), false);
      // A change here while the listing was in flight wins over it.
      const listedUnder = store.read();
      store.write({ ...listedUnder, deviceIcon: "rocket", hubIcon: "rocket" });
      assert.equal(sync(ownRowListing("cat", "Other"), listedUnder), false);
      assert.equal(store.read().deviceIcon, "rocket");
      assert.equal(store.read().deviceName, "Studio");
      // So does a sign-out: the record is not written back.
      const beforeSignOut = store.read();
      store.clear();
      assert.equal(sync(ownRowListing("cat"), beforeSignOut), false);
      assert.equal(store.read(), null);
      assert.equal(calls.length, 0, "nothing was pushed");
    },
  );

  await check(
    "device sync: a hub copy that did not move but went stale (a default name migrated forward, a detection that improved with an upgrade) gets this device's name and icon, not pinned over them",
    async () => {
      const { fetchImpl, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const store = memoryStore();
      const deps = {
        service: createAccountService({ baseUrl: CONFIG.hubUrl, fetchImpl }),
        store,
        deviceId: "device-uuid",
        detectedIcon: "mini",
      };
      // Enrolled by a build that took this Mac mini for a laptop and
      // named it by its raw hostname, since migrated forward here (which
      // records the name it left as the hub's).
      store.write({
        credential: "c",
        accountId: "a",
        deviceName: "Mini",
        hubName: "mini.local",
      });
      assert.equal(
        syncHubDevice(
          deps,
          store.read(),
          ownRowListing("laptop", "mini.local"),
        ),
        false,
      );
      // A read landing while the push is out does not repeat it.
      syncHubDevice(deps, store.read(), ownRowListing("laptop", "mini.local"));
      // The push is fire-and-forget: give it a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(
        calls.map((c) => [c.url, JSON.parse(c.init.body)]),
        [
          [
            CONFIG.hubUrl + HUB_ROUTES.updateDevice.path("device-uuid"),
            { name: "Mini", icon: "mini" },
          ],
        ],
      );
      assert.equal(store.read().deviceName, "Mini");
      assert.equal(store.read().deviceIcon, undefined);
      // Recorded as the hub's once it landed, so the next listing moves
      // nothing, and a peer changing either back reads as the hub moving.
      assert.equal(store.read().hubName, "Mini");
      assert.equal(store.read().hubIcon, "mini");
      assert.equal(
        syncHubDevice(deps, store.read(), ownRowListing("mini", "Mini")),
        false,
      );
      assert.equal(
        syncHubDevice(deps, store.read(), ownRowListing("laptop", "Mini")),
        true,
      );
      assert.equal(store.read().deviceIcon, "laptop");
      assert.equal(calls.length, 1);
      // A record from before hubName holds no answer for the name, and a
      // hub name that differs is a peer's rename (a name only ever
      // changed on this device before), so it is adopted, not pushed
      // over.
      store.write({ credential: "c", accountId: "a", deviceName: "Mini" });
      assert.equal(
        syncHubDevice(deps, store.read(), ownRowListing("mini", "Office")),
        true,
      );
      assert.equal(store.read().deviceName, "Office");
      assert.equal(calls.length, 1);
    },
  );

  await check(
    "device sync: a change made here while a stale push is out waits for it to land, so the push cannot land over the change",
    async () => {
      let release;
      const held = new Promise((resolve) => (release = resolve));
      const { fetchImpl, calls } = recordingFetch(async () => {
        if (calls.length === 1) await held;
        return new Response(null, { status: 204 });
      });
      const store = memoryStore();
      const deps = {
        service: createAccountService({ baseUrl: CONFIG.hubUrl, fetchImpl }),
        store,
        deviceId: "device-uuid",
        detectedIcon: "laptop",
      };
      store.write({
        credential: "c",
        accountId: "a",
        deviceName: "Mac",
        hubName: "Mac.local",
        hubIcon: "laptop",
      });
      syncHubDevice(deps, store.read(), ownRowListing("laptop", "Mac.local"));
      const renamed = updateDevice(deps, store.read(), "device-uuid", {
        name: "Work",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        calls.length,
        1,
        "the rename went out before the push landed",
      );
      release();
      await renamed;
      assert.deepEqual(
        calls.map((c) => JSON.parse(c.init.body)),
        [{ name: "Mac" }, { name: "Work" }],
      );
      assert.equal(store.read().deviceName, "Work");
      assert.equal(store.read().hubName, "Work");
    },
  );

  await check(
    "device update: updateDevice writes the hub first and keeps the change for this device only, the detected icon drops the pick, and a change the hub refused keeps nothing",
    async () => {
      let status = 204;
      const { service, calls } = stubService(
        () => new Response(null, { status }),
        CONFIG.hubUrl,
      );
      const store = memoryStore();
      const deps = {
        service,
        store,
        deviceId: "device-uuid",
        detectedIcon: "laptop",
      };
      const pick = (deviceId, icon) =>
        updateDevice(deps, store.read(), deviceId, { icon });
      store.write({ credential: "c", accountId: "a", deviceName: "d" });
      assert.equal(
        effectiveDeviceIcon(store.read(), store, "laptop"),
        "laptop",
      );
      await pick("device-uuid", "mini");
      assert.equal(store.read().deviceIcon, "mini");
      assert.equal(effectiveDeviceIcon(store.read(), store, "laptop"), "mini");
      // Picking the detected icon removes the key outright, so the next
      // enrollment sends whatever the machine detects by then.
      await pick("device-uuid", "laptop");
      assert.deepEqual(store.read(), {
        credential: "c",
        accountId: "a",
        deviceName: "d",
        hubIcon: "laptop",
      });
      await updateDevice(deps, store.read(), "device-uuid", {
        name: "Studio",
      });
      assert.equal(store.read().deviceName, "Studio");
      assert.equal(store.read().hubName, "Studio");
      // A peer's change is the hub's alone.
      await pick("peer-uuid", "cat");
      await updateDevice(deps, store.read(), "peer-uuid", { name: "Work" });
      assert.equal(store.read().deviceIcon, undefined);
      assert.equal(store.read().deviceName, "Studio");
      const self = CONFIG.hubUrl + HUB_ROUTES.updateDevice.path("device-uuid");
      const peer = CONFIG.hubUrl + HUB_ROUTES.updateDevice.path("peer-uuid");
      assert.deepEqual(
        calls.map((c) => [c.url, JSON.parse(c.init.body)]),
        [
          [self, { icon: "mini" }],
          [self, { icon: "laptop" }],
          [self, { name: "Studio" }],
          [peer, { icon: "cat" }],
          [peer, { name: "Work" }],
        ],
      );
      status = 500;
      await assert.rejects(pick("device-uuid", "mini"));
      assert.equal(store.read().deviceIcon, undefined);
      // The pick outlives a sign-out, like the name.
      store.write({ ...store.read(), deviceIcon: "server" });
      store.clear();
      assert.equal(store.rememberedDeviceIcon(), "server");
      assert.equal(
        effectiveDeviceIcon(store.read(), store, "laptop"),
        "server",
      );
      // A stored icon this build does not know reads as no pick.
      const odd = createCoreAccountStore({
        storage: {
          readRaw: () =>
            JSON.stringify({
              v: 1,
              enc: false,
              credential: "c",
              accountId: "a",
              deviceName: "d",
              deviceIcon: "hologram",
            }),
          writeRaw: () => {},
          removeRaw: () => {},
        },
        cipher: PLAINTEXT_CIPHER,
      });
      assert.equal(odd.read().deviceIcon, undefined);
      assert.equal(odd.rememberedDeviceIcon(), null);
      // A pick stored before the rename, under deviceKind, still reads,
      // and the next write stores it as deviceIcon.
      const legacy = memoryStore(
        JSON.stringify({
          v: 1,
          enc: false,
          credential: "c",
          accountId: "a",
          deviceName: "d",
          deviceKind: "cat",
        }),
      );
      assert.equal(legacy.read().deviceIcon, "cat");
      legacy.write(legacy.read());
      assert.deepEqual(
        [legacy.raw().deviceIcon, legacy.raw().deviceKind],
        ["cat", undefined],
      );
    },
  );

  await check(
    "device icon detection: Apple product names and model identifiers, DMI chassis codes, virtual machines",
    () => {
      assert.equal(deviceShapeFromAppleModel("MacBook Pro"), "laptop");
      assert.equal(deviceShapeFromAppleModel("MacBookAir10,1"), "laptop");
      assert.equal(deviceShapeFromAppleModel("Mac mini (2024)"), "mini");
      assert.equal(deviceShapeFromAppleModel("Macmini9,1"), "mini");
      assert.equal(deviceShapeFromAppleModel("Mac Studio"), "mini");
      assert.equal(deviceShapeFromAppleModel("iMac21,1"), "desktop");
      assert.equal(deviceShapeFromAppleModel("Mac Pro"), "desktop");
      // The bare Apple silicon identifier says nothing about the shape.
      assert.equal(deviceShapeFromAppleModel("Mac16,10"), null);
      assert.equal(
        appleProductNameOf(
          '  |   "product-name" = <"Mac mini (2024)">\n  |   "target-type" = <"J773g">',
        ),
        "Mac mini (2024)",
      );
      assert.equal(appleProductNameOf("no product node here"), null);
      assert.equal(dmi("10", "LENOVO", "20XW"), "laptop");
      assert.equal(dmi("3"), "desktop");
      assert.equal(dmi("23"), "server");
      assert.equal(dmi("35"), "mini");
      assert.equal(dmi("2"), null, "an Unknown chassis is no answer");
      assert.equal(dmi("10", "QEMU", "Standard PC"), "server");
      assert.equal(dmi("9", "Apple Inc.", "MacBookPro18,3"), "laptop");
    },
  );

  await check(
    "sign-out flow: signOutDevice revokes THIS device then clears, and still clears (reporting the failure) when the revoke fails",
    async () => {
      const { service, calls } = stubService(
        () => new Response(null, { status: 204 }),
        CONFIG.hubUrl,
      );
      const store = memoryStore();
      store.write({ credential: "cred-1", accountId: "a", deviceName: "d" });
      await signOutDevice({
        config: CONFIG,
        service,
        store,
        deviceId: "device-uuid",
      });
      assert.equal(store.read(), null);
      assert.equal(calls[0].init.method, "DELETE");
      assert.equal(calls[0].init.headers.authorization, "Bearer cred-1");

      // The failure path: revoke rejects, the clear still lands and the
      // failure reaches the caller's reporter instead of throwing.
      const failing = createAccountService({
        baseUrl: CONFIG.hubUrl,
        fetchImpl: () => Promise.reject(new TypeError("offline")),
      });
      store.write({ credential: "cred-2", accountId: "a", deviceName: "d" });
      let reported = null;
      await signOutDevice({
        config: CONFIG,
        service: failing,
        store,
        deviceId: "device-uuid",
        onRevokeFailure: (error) => {
          reported = error;
        },
      });
      assert.equal(store.read(), null, "a failed revoke blocked the clear");
      assert.match(String(reported), /offline/);
      // The undelivered revoke is parked with the credential it needs,
      // and delivered by the retry: a 204 clears it, and so does a
      // refusal (the hub already does not honor it), while an outage
      // keeps it for the next try. A refusal at the sign-out itself is
      // never parked.
      assert.equal(store.readParked()?.credential, "cred-2");
      await retryParkedRevoke({
        config: CONFIG,
        service: failing,
        store,
        deviceId: "device-uuid",
      });
      assert.equal(
        store.readParked()?.credential,
        "cred-2",
        "an outage cleared the parking",
      );
      const { fetchImpl: okFetch, calls: retryCalls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      await retryParkedRevoke({
        config: CONFIG,
        service: createAccountService({
          baseUrl: CONFIG.hubUrl,
          fetchImpl: okFetch,
        }),
        store,
        deviceId: "device-uuid",
      });
      assert.equal(retryCalls[0].init.headers.authorization, "Bearer cred-2");
      assert.equal(
        store.readParked(),
        null,
        "a delivered revoke stayed parked",
      );
      const refusing = createAccountService({
        baseUrl: CONFIG.hubUrl,
        fetchImpl: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: "invalid device credential" }),
              {
                status: 401,
              },
            ),
          ),
      });
      store.write({ credential: "cred-3", accountId: "a", deviceName: "d" });
      await signOutDevice({
        config: CONFIG,
        service: refusing,
        store,
        deviceId: "device-uuid",
      });
      assert.equal(store.readParked(), null, "a refused revoke was parked");
      // The name outlives the sign-out into the next enrollment.
      assert.equal(store.rememberedDeviceName(), "d");
    },
  );

  const tmp = mkdtempSync(join(tmpdir(), "sm-account-"));
  try {
    await check(
      "store: an encrypting cipher round trips and writes ciphertext with enc:true",
      () => {
        const filePath = join(tmp, "enc.json");
        const encCipher = {
          available: true,
          encrypt: (s) => Buffer.from(s).toString("base64"),
          decrypt: (p) => Buffer.from(p, "base64").toString("utf8"),
        };
        const store = createAccountStore({ filePath, cipher: encCipher });
        store.write({
          credential: "secret-credential",
          accountId: "acct-1",
          deviceName: "Mac",
        });
        const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
        assert.equal(onDisk.enc, true);
        assert.equal(onDisk.v, 1);
        assert.notEqual(onDisk.credential, "secret-credential");
        const read = store.read();
        assert.deepEqual(read, {
          credential: "secret-credential",
          accountId: "acct-1",
          deviceName: "Mac",
        });
      },
    );

    await check(
      "store: an unavailable cipher stores plaintext with enc:false and still round trips",
      () => {
        const filePath = join(tmp, "plain.json");
        const store = createAccountStore({
          filePath,
          cipher: PLAINTEXT_CIPHER,
        });
        store.write({
          credential: "plain-credential",
          accountId: "acct-2",
          deviceName: "Linux box",
        });
        const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
        assert.equal(onDisk.enc, false);
        assert.equal(onDisk.credential, "plain-credential");
        assert.equal(store.read().credential, "plain-credential");
      },
    );

    await check(
      "store: a missing file and corrupt JSON both read as null, and clear removes the file",
      () => {
        const cipher = PLAINTEXT_CIPHER;
        const missing = createAccountStore({
          filePath: join(tmp, "does-not-exist.json"),
          cipher,
        });
        assert.equal(missing.read(), null, "missing file should read null");

        const corruptPath = join(tmp, "corrupt.json");
        writeFileSync(corruptPath, "{ not valid json");
        const corrupt = createAccountStore({ filePath: corruptPath, cipher });
        assert.equal(corrupt.read(), null, "corrupt JSON should read null");

        const clearPath = join(tmp, "clear.json");
        const store = createAccountStore({ filePath: clearPath, cipher });
        store.write({ credential: "c", accountId: "a", deviceName: "d" });
        assert.notEqual(store.read(), null);
        store.clear();
        assert.equal(store.read(), null, "clear should remove the file");
      },
    );

    await check(
      "store core: an in-memory backing round trips under both an encrypting and a plaintext cipher, and the envelope matches the fs adapter",
      () => {
        // Drive the storage-agnostic core directly with an in-memory
        // backing, the exact seam the browser localStorage store will use,
        // and prove the document shape is identical to the desktop file.
        for (const available of [true, false]) {
          let stored = null;
          const storage = {
            readRaw: () => stored,
            writeRaw: (text) => {
              stored = text;
            },
            removeRaw: () => {
              stored = null;
            },
          };
          const cipher = {
            available,
            encrypt: (s) => Buffer.from(s).toString("base64"),
            decrypt: (p) => Buffer.from(p, "base64").toString("utf8"),
          };
          const store = createCoreAccountStore({ storage, cipher });
          store.write({
            credential: "secret",
            accountId: "acct-core",
            deviceName: "Web",
          });
          const doc = JSON.parse(stored);
          assert.equal(doc.v, 1);
          assert.equal(doc.enc, available);
          // enc:true stores ciphertext, enc:false stores the plaintext.
          assert.equal(
            doc.credential !== "secret",
            available,
            "the enc flag did not match whether the credential was encrypted",
          );
          assert.deepEqual(store.read(), {
            credential: "secret",
            accountId: "acct-core",
            deviceName: "Web",
          });
          // Corrupt bytes read as signed out, and clear empties the backing.
          stored = "{ not valid json";
          assert.equal(store.read(), null, "corrupt backing should read null");
          store.write({ credential: "c", accountId: "a", deviceName: "d" });
          store.clear();
          // Clear signs out but keeps the name, so the next enrollment
          // keeps calling the device what it was called.
          assert.equal(store.read(), null, "clear should sign out");
          assert.equal(store.rememberedDeviceName(), "d");
          assert.equal(store.readParked(), null);
          assert.equal(
            JSON.parse(stored).credential,
            undefined,
            "clear left the credential in the backing",
          );
          // A parked credential is signed out too, readable only as
          // parked, and encrypted the same way as a live one.
          store.park({ credential: "dead", accountId: "a", deviceName: "d" });
          assert.equal(store.read(), null, "a parked credential read as live");
          assert.deepEqual(store.readParked(), {
            credential: "dead",
            accountId: "a",
            deviceName: "d",
          });
          assert.equal(
            JSON.parse(stored).parked.credential !== "dead",
            available,
            "the parked credential was not encrypted like a live one",
          );
          store.clear();
          assert.deepEqual(
            store.readParked()?.credential,
            "dead",
            "clear dropped the parked revoke",
          );
          store.clearParked();
          assert.equal(store.readParked(), null);
          assert.equal(store.rememberedDeviceName(), "d");
          store.write({ credential: "c2", accountId: "a", deviceName: "d2" });
          assert.equal(store.readParked(), null, "a sign-in kept the parking");
          store.clear();
          assert.equal(store.read(), null, "a cleared store reads null");
        }
      },
    );

    await check(
      "command access: the switch rides the account record (absent is off), survives a rename's rewrite, is dropped by a sign-out, and a re-enrollment keeps it only under the same account",
      async () => {
        const filePath = join(tmp, "access.json");
        const store = createAccountStore({
          filePath,
          cipher: PLAINTEXT_CIPHER,
        });
        const record = {
          credential: "c",
          accountId: "acct-1",
          deviceName: "d",
        };
        store.write(record);
        assert.equal(store.read().acceptsCommands, undefined, "absent is off");
        store.write({ ...record, acceptsCommands: true });
        assert.equal(store.read().acceptsCommands, true);
        assert.equal(
          JSON.parse(readFileSync(filePath, "utf8")).acceptsCommands,
          true,
        );
        // A rewrite of the record (a rename) carries it along.
        store.write({ ...store.read(), deviceName: "renamed" });
        assert.equal(store.read().acceptsCommands, true);
        // Off is stored as absent, not as a false beside the credential.
        store.write({ ...store.read(), acceptsCommands: false });
        assert.equal(
          "acceptsCommands" in JSON.parse(readFileSync(filePath, "utf8")),
          false,
        );
        // A sign-out keeps the name and drops the switch with the
        // credential, so signing back in starts with it off.
        store.write({ ...store.read(), acceptsCommands: true });
        store.clear();
        assert.equal(store.read(), null);
        assert.equal(
          "acceptsCommands" in JSON.parse(readFileSync(filePath, "utf8")),
          false,
          "a sign-out left the switch behind",
        );
        assert.equal(store.rememberedDeviceName(), "renamed");

        const { service } = stubService(
          () => json({ credential: "cred-2", device: DEVICE }),
          CONFIG.hubUrl,
        );
        const enrolled = memoryStore();
        const enrollAs = (sub) =>
          enrollDevice(
            {
              config: CONFIG,
              service,
              store: enrolled,
              deviceId: "device-uuid",
              fallbackDeviceName: "Mac",
              platform: "darwin",
              detectedIcon: "laptop",
            },
            fakeSessionJwt(sub),
          );
        await enrollAs("user_abc");
        enrolled.write({ ...enrolled.read(), acceptsCommands: true });
        await enrollAs("user_abc");
        assert.equal(
          enrolled.read().acceptsCommands,
          true,
          "a same-account re-enrollment turned the switch off",
        );
        await enrollAs("user_other");
        assert.equal(
          enrolled.read().acceptsCommands,
          undefined,
          "another account inherited the switch",
        );
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  await check(
    "device name: the hostname default drops the mDNS and domain suffixes and never blanks",
    () => {
      assert.equal(shortHostname("Rins-MacBook-Pro.local"), "Rins-MacBook-Pro");
      assert.equal(shortHostname("thinkpad.corp.example"), "thinkpad");
      assert.equal(shortHostname("DESKTOP-4F2C9D1"), "DESKTOP-4F2C9D1");
      // A name that would strip to nothing comes back whole.
      assert.equal(shortHostname(".local"), ".local");
      assert.equal(shortHostname(""), "");
    },
  );

  await check(
    'token: deriveAccountId reads a JWT sub and returns "" for anything malformed without throwing',
    () => {
      // The happy path derives the sub, the account id a Clerk session
      // token carries.
      assert.equal(deriveAccountId(fakeSessionJwt("user_x")), "user_x");
      // A three-segment token whose payload is not valid base64/JSON.
      assert.equal(deriveAccountId("aaa.!!!not base64 or json!!!.sig"), "");
      // Valid base64url that decodes to non-JSON bytes.
      assert.equal(deriveAccountId(`aaa.${b64url("not json")}.sig`), "");
      // Valid JSON whose sub is not a string.
      assert.equal(
        deriveAccountId(`aaa.${b64url(JSON.stringify({ sub: 42 }))}.sig`),
        "",
      );
      // Not a three-segment JWT at all (an opaque token).
      assert.equal(deriveAccountId("opaque-token"), "");
    },
  );

  await check(
    "shape: the device credential never appears in a renderer-visible object",
    () => {
      // AccountStatus is the whole renderer view of account state. It must
      // never carry the credential, so a compromised renderer cannot read
      // it back out of a status poll.
      assert.ok(
        !("credential" in AccountStatusSchema.shape),
        "AccountStatusSchema exposes a credential field",
      );
      const status = AccountStatusSchema.parse({
        configured: true,
        signedIn: true,
        accountId: "acct-1",
        deviceName: "Mac",
        deviceIcon: "laptop",
        detectedDeviceIcon: "laptop",
        sharedSignIn: false,
      });
      assert.ok(
        !("credential" in status),
        "an AccountStatus carries a credential",
      );
      // DeviceInfo is the per-device shape the device hub reports and
      // the renderer lists. The credential belongs only to the enroll
      // response, never to a listed device.
      const device = DeviceInfoSchema.parse({ ...DEVICE, credential: "c" });
      assert.ok(!("credential" in device), "a DeviceInfo carries a credential");
    },
  );

  await check(
    "contract: setDeviceName rejects an empty and an over-256-char name",
    () => {
      const input = accountContract.calls.setDeviceName.input;
      const rename = (name) =>
        input.safeParse({ deviceId: "device-uuid", name }).success;
      assert.equal(rename("A valid name"), true);
      assert.equal(
        rename(""),
        false,
        "an empty device name should be rejected",
      );
      assert.equal(
        rename("x".repeat(300)),
        false,
        "a 300-char device name should be rejected",
      );
    },
  );

  await check("contract: enroll rejects an empty session token", () => {
    const input = accountContract.calls.enroll.input;
    assert.equal(input.safeParse(fakeSessionJwt("user_x")).success, true);
    assert.equal(
      input.safeParse("").success,
      false,
      "an empty enroll token should be rejected",
    );
  });

  await check(
    "envFile: parseDotenv skips comments and blanks, strips quotes, ignores malformed lines, and drops __proto__",
    () => {
      const parsed = parseDotenv(
        [
          "# a comment",
          "",
          "   ",
          "SM_DEVICE_HUB_URL=https://hub.test",
          'QUOTED="double quoted"',
          "SINGLE='single quoted'",
          "no_equals_here",
          "=leading-equals",
          "__proto__=polluted",
        ].join("\n"),
      );
      assert.equal(parsed.SM_DEVICE_HUB_URL, "https://hub.test");
      assert.equal(parsed.QUOTED, "double quoted");
      assert.equal(parsed.SINGLE, "single quoted");
      assert.ok(!("no_equals_here" in parsed), "a line with no = was kept");
      assert.ok(!("" in parsed), "a leading-= line was kept");
      // The __proto__ line must not pollute the prototype chain.
      assert.ok(
        !Object.prototype.hasOwnProperty.call(parsed, "__proto__"),
        "__proto__ leaked in as an own key",
      );
      assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
      assert.equal({}.polluted, undefined, "Object.prototype was polluted");
    },
  );

  await check(
    "envFile: mergeServiceEnv layers file < baked < process.env",
    () => {
      const merged = mergeServiceEnv(
        {
          SM_DEVICE_HUB_URL: "https://file.example",
          SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_file",
          ONLY_FILE: "f",
        },
        {
          SM_DEVICE_HUB_URL: "https://baked.example",
          SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_baked",
          ONLY_BAKED: "b",
        },
        { SM_DEVICE_HUB_URL: "https://env.example", ONLY_ENV: "e" },
      );
      assert.equal(
        merged.SM_DEVICE_HUB_URL,
        "https://env.example",
        "process.env did not win over baked and file",
      );
      assert.equal(
        merged.SM_ACCOUNT_CLERK_PUBLISHABLE_KEY,
        "pk_baked",
        "a baked value did not win over the file",
      );
      // Each layer's uncontested keys all survive the merge.
      assert.equal(merged.ONLY_FILE, "f");
      assert.equal(merged.ONLY_BAKED, "b");
      assert.equal(merged.ONLY_ENV, "e");
    },
  );

  done();
}

main().catch(fail);
