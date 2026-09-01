// Durable proof for the electron-free account layer (main/account/*,
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
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// and @shared imports resolve. See package.json "account:check".
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isConfigured,
  mergeServiceEnv,
  parseDotenv,
  resolveServiceConfig,
} from "../shared/account/serviceConfig.ts";
import { enrollDevice, signOutDevice } from "../shared/account/enroll.ts";
import { createAccountService } from "../shared/account/service.ts";
import { deriveAccountId } from "../shared/account/token.ts";
import { createAccountStore } from "../main/account/credentialStore.ts";
import { createAccountStore as createCoreAccountStore } from "../shared/account/credentialStore.ts";
import { createGrantStore } from "../main/account/grantStore.ts";
import {
  AccountStatusSchema,
  accountContract,
} from "@shared/ipc/modules/account";
import { DeviceInfoSchema, HUB_ROUTES } from "@shared/hub/protocol";
import { fakeSessionJwt, makeProof } from "./lib/checkKit.mjs";

// A resolved config that isConfigured accepts, for the flows that need
// one. The hub URL is never dialled: fetch is always stubbed.
const CONFIG = resolveServiceConfig({
  SM_ACCOUNT_HUB_URL: "https://hub.test",
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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// The plaintext cipher stub: a keychain-less machine's fallback, where
// the store writes enc:false and the round trip is the identity.
const PLAINTEXT_CIPHER = {
  available: false,
  encrypt: (s) => s,
  decrypt: (p) => p,
};

// The one device the hub stubs report.
const DEVICE = {
  deviceId: "device-uuid",
  name: "Test Mac",
  platform: "darwin",
  createdAt: 1_700_000_000_000,
  lastSeenAt: null,
  online: true,
};

const { check, done, fail } = makeProof("account layer proof");

async function main() {
  console.log("account layer proof\n");

  await check(
    "config: isConfigured is false until every required field is set",
    () => {
      assert.equal(isConfigured(CONFIG), true);
      assert.equal(isConfigured(resolveServiceConfig({})), false);
      const missingKey = resolveServiceConfig({
        SM_ACCOUNT_HUB_URL: "https://hub.test",
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
      const { fetchImpl, calls } = recordingFetch(() =>
        json({ credential: "device-credential", device: DEVICE }),
      );
      const service = createAccountService({
        baseUrl: "https://hub.test",
        fetchImpl,
      });
      const result = await service.enroll("session-token", {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
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
      });
    },
  );

  await check(
    "service: listDevices GETs the devices route under the credential bearer",
    async () => {
      const { fetchImpl, calls } = recordingFetch(() =>
        json({ devices: [DEVICE] }),
      );
      const service = createAccountService({
        baseUrl: "https://hub.test",
        fetchImpl,
      });
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
    "service: revoke DELETEs the per-device route and tolerates a 204",
    async () => {
      const { fetchImpl, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const service = createAccountService({
        baseUrl: "https://hub.test",
        fetchImpl,
      });
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
      const { fetchImpl, calls } = recordingFetch(() =>
        json({ ticket: "the-ticket", expiresInMs: 30_000 }),
      );
      const service = createAccountService({
        baseUrl: "https://hub.test",
        fetchImpl,
      });
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
      const { fetchImpl, calls } = recordingFetch(responder);
      const service = createAccountService({
        baseUrl: "https://hub.test",
        fetchImpl,
      });
      await service.enroll("session-token", {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
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
    "service: a non-2xx with an ErrorBody throws the hub's error message",
    async () => {
      const { fetchImpl } = recordingFetch(() =>
        json({ error: "device revoked" }, 403),
      );
      const service = createAccountService({
        baseUrl: "https://hub.test",
        fetchImpl,
      });
      await assert.rejects(
        () => service.listDevices("device-credential"),
        /device revoked/,
      );
    },
  );

  // An in-memory store over the shared core, the seam both shells'
  // enroll/sign-out orchestration is driven through.
  const memoryStore = () => {
    let stored = null;
    return createCoreAccountStore({
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
  };

  await check(
    "enroll flow: enrollDevice stores the credential with the derived accountId under the stored-or-fallback device name, and an unconfigured build rejects before any fetch",
    async () => {
      const { fetchImpl, calls } = recordingFetch(() =>
        json({ credential: "cred-1", device: DEVICE }),
      );
      const service = createAccountService({
        baseUrl: CONFIG.hubUrl,
        fetchImpl,
      });
      const store = memoryStore();
      await enrollDevice(
        {
          config: CONFIG,
          service,
          store,
          deviceId: "device-uuid",
          fallbackDeviceName: "Fallback Mac",
          platform: "darwin",
        },
        fakeSessionJwt("user_abc"),
      );
      assert.deepEqual(store.read(), {
        credential: "cred-1",
        accountId: "user_abc",
        deviceName: "Fallback Mac",
      });
      // A stored name survives re-enrollment. The fallback is only for
      // a first sign-in.
      store.write({ ...store.read(), deviceName: "Renamed" });
      await enrollDevice(
        {
          config: CONFIG,
          service,
          store,
          deviceId: "device-uuid",
          fallbackDeviceName: "Fallback Mac",
          platform: "darwin",
        },
        fakeSessionJwt("user_abc"),
      );
      assert.equal(store.read().deviceName, "Renamed");

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
            },
            fakeSessionJwt("user_abc"),
          ),
        /not configured/,
      );
      assert.equal(calls.length, before, "an unconfigured enroll fetched");
    },
  );

  await check(
    "sign-out flow: signOutDevice revokes THIS device then clears, and still clears (reporting the failure) when the revoke fails",
    async () => {
      const { fetchImpl, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const service = createAccountService({
        baseUrl: CONFIG.hubUrl,
        fetchImpl,
      });
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
          assert.equal(stored, null, "clear should empty the backing");
          assert.equal(store.read(), null, "a cleared store reads null");
        }
      },
    );

    await check(
      "grants: grant then list returns the peer, revoke removes it, and a mismatched account yields no grants",
      () => {
        const filePath = join(tmp, "grants.json");
        const grants = createGrantStore({ filePath });
        assert.deepEqual(
          grants.list("acct-1"),
          [],
          "a fresh store has no grants",
        );
        grants.grant("acct-1", "peer-a");
        grants.grant("acct-1", "peer-b");
        // A repeat grant is idempotent, not a duplicate.
        grants.grant("acct-1", "peer-a");
        assert.deepEqual(grants.list("acct-1").toSorted(), [
          "peer-a",
          "peer-b",
        ]);
        grants.revoke("acct-1", "peer-a");
        assert.deepEqual(grants.list("acct-1"), ["peer-b"]);
        // A different account never sees acct-1's grants, so grants cannot
        // leak across accounts even from the same file.
        assert.deepEqual(
          grants.list("acct-2"),
          [],
          "a mismatched account saw another account's grants",
        );
        const record = grants.read();
        assert.equal(record.accountId, "acct-1");
      },
    );

    await check(
      "grants: a grant under a new account resets the record, dropping the old account's grants",
      () => {
        const filePath = join(tmp, "grants-reset.json");
        const grants = createGrantStore({ filePath });
        grants.grant("acct-1", "peer-a");
        grants.grant("acct-1", "peer-b");
        // Granting under a DIFFERENT account resets to the new account, so
        // the old grants are gone rather than merged in.
        grants.grant("acct-2", "peer-c");
        assert.deepEqual(grants.list("acct-2"), ["peer-c"]);
        assert.deepEqual(
          grants.list("acct-1"),
          [],
          "the old account's grants survived a reset",
        );
        assert.equal(grants.read().accountId, "acct-2");
      },
    );

    await check(
      "grants: a missing file and corrupt JSON both read as null, and clear removes the file",
      () => {
        const missing = createGrantStore({
          filePath: join(tmp, "grants-missing.json"),
        });
        assert.equal(missing.read(), null, "missing file should read null");
        assert.deepEqual(
          missing.list("acct-1"),
          [],
          "missing file has no grants",
        );

        const corruptPath = join(tmp, "grants-corrupt.json");
        writeFileSync(corruptPath, "{ not valid json");
        const corrupt = createGrantStore({ filePath: corruptPath });
        assert.equal(corrupt.read(), null, "corrupt JSON should read null");

        const clearPath = join(tmp, "grants-clear.json");
        const store = createGrantStore({ filePath: clearPath });
        store.grant("acct-1", "peer-a");
        assert.notEqual(store.read(), null);
        store.clear();
        assert.equal(store.read(), null, "clear should remove the file");
      },
    );

    await check("grants: the atomic write leaves the file mode 0o600", () => {
      const filePath = join(tmp, "grants-mode.json");
      const grants = createGrantStore({ filePath });
      grants.grant("acct-1", "peer-a");
      // The grant list is not world-readable in a shared userData dir.
      // Mode bits are a unix concept, so skip the check on win32.
      if (process.platform !== "win32") {
        assert.equal(statSync(filePath).mode & 0o777, 0o600);
      }
    });

    await check(
      "grants: the list is capped, so a runaway write past the ceiling is refused while a re-grant at the cap stays idempotent",
      () => {
        const filePath = join(tmp, "grants-cap.json");
        const grants = createGrantStore({ filePath });
        // Fill exactly to the 256 ceiling (MAX_GRANTED_PEERS, a plain
        // host-local bound on the persisted list).
        for (let i = 0; i < 256; i += 1) grants.grant("acct-1", `peer-${i}`);
        assert.equal(grants.list("acct-1").length, 256);
        // A NEW peer past the cap is refused rather than growing the file.
        assert.throws(
          () => grants.grant("acct-1", "peer-over"),
          /cannot grant more than 256/,
        );
        assert.equal(grants.list("acct-1").length, 256, "the cap was exceeded");
        // Re-granting an already-trusted peer at the cap is still a no-op,
        // not a spurious over-cap throw.
        grants.grant("acct-1", "peer-0");
        assert.equal(grants.list("acct-1").length, 256);
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

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
      });
      assert.ok(
        !("credential" in status),
        "an AccountStatus carries a credential",
      );
      // DeviceInfo is the per-device shape the hub reports and the
      // renderer lists. The credential belongs only to the enroll
      // response, never to a listed device.
      assert.ok(
        !("credential" in DeviceInfoSchema.shape),
        "DeviceInfoSchema exposes a credential field",
      );
      const device = DeviceInfoSchema.parse(DEVICE);
      assert.ok(!("credential" in device), "a DeviceInfo carries a credential");
    },
  );

  await check(
    "contract: setDeviceName rejects an empty and an over-256-char name",
    () => {
      const input = accountContract.calls.setDeviceName.input;
      assert.equal(input.safeParse("A valid name").success, true);
      assert.equal(
        input.safeParse("").success,
        false,
        "an empty device name should be rejected",
      );
      assert.equal(
        input.safeParse("x".repeat(300)).success,
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
          "SM_ACCOUNT_HUB_URL=https://hub.test",
          'QUOTED="double quoted"',
          "SINGLE='single quoted'",
          "no_equals_here",
          "=leading-equals",
          "__proto__=polluted",
        ].join("\n"),
      );
      assert.equal(parsed.SM_ACCOUNT_HUB_URL, "https://hub.test");
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
          SM_ACCOUNT_HUB_URL: "https://file.example",
          SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_file",
          ONLY_FILE: "f",
        },
        {
          SM_ACCOUNT_HUB_URL: "https://baked.example",
          SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_baked",
          ONLY_BAKED: "b",
        },
        { SM_ACCOUNT_HUB_URL: "https://env.example", ONLY_ENV: "e" },
      );
      assert.equal(
        merged.SM_ACCOUNT_HUB_URL,
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
