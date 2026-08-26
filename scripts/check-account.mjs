// Durable proof for the electron-free account layer (main/account/*).
// Drives the pure modules end to end with stubs and asserts the security
// and wire-shape invariants without electron, without a browser and
// without the network: the PKCE math and authorize-URL params, the
// redirect parse, the token exchange form fields and error path, the
// relay client's route/method/auth-tier discipline against the shared
// schemas, the credential store's encrypt and plaintext-fallback round
// trips plus its corrupt/missing tolerance, the full loopback login flow
// including the state-mismatch and timeout rejections, the loopback
// server binding 127.0.0.1 only, deriveAccountId's tolerance of a
// malformed token, the .env.account parser and the file/process.env merge
// precedence, the setDeviceName bounds, and the shape guarantee that the
// device credential never appears in a renderer-visible object.
//
// The one thing it cannot cover is the safeStorage cipher round trip
// itself: that is an OS-keychain, electron-only seam, so the store here
// runs against injected cipher stubs and the real encryption path is
// exercised by hand.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// and @shared imports resolve. See package.json "account:check".
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  generateState,
  parseRedirectQuery,
} from "../main/account/pkce.ts";
import {
  isConfigured,
  mergeServiceEnv,
  parseDotenv,
  resolveServiceConfig,
} from "../main/account/serviceConfig.ts";
import { exchangeCodeForToken } from "../main/account/tokenExchange.ts";
import { createAccountService } from "../main/account/service.ts";
import { createAccountStore } from "../main/account/credentialStore.ts";
import { createGrantStore } from "../main/account/grantStore.ts";
import { deriveAccountId, runLoginFlow } from "../main/account/login.ts";
import {
  AccountStatusSchema,
  accountContract,
} from "@shared/ipc/modules/account";
import { DeviceInfoSchema, RELAY_ROUTES } from "@shared/relay/protocol";

// A resolved config that isConfigured accepts, for the flows that need
// one. The URLs are never dialled: fetch is always stubbed.
const CONFIG = resolveServiceConfig({
  SM_ACCOUNT_RELAY_URL: "https://relay.test",
  SM_ACCOUNT_OAUTH_AUTHORIZE_URL: "https://auth.test/authorize",
  SM_ACCOUNT_OAUTH_TOKEN_URL: "https://auth.test/token",
  SM_ACCOUNT_OAUTH_CLIENT_ID: "client-abc",
  SM_ACCOUNT_OAUTH_SCOPES: "openid profile",
});

// base64url without padding, matching the encoding pkce.ts uses.
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// A JWT-shaped token whose payload carries the given sub, so the login
// flow's best-effort accountId derivation has something to read.
function jwtWithSub(sub) {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

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
// the store writes enc:false and the round trip is the identity. Hoisted
// so every login and store assertion shares one copy.
const PLAINTEXT_CIPHER = {
  available: false,
  encrypt: (s) => s,
  decrypt: (p) => p,
};

// The sub the standard login fetch mints in its JWT, and the credential
// its enroll returns, so the login assertions can name the expected
// results as constants.
const LOGIN_SUB = "user_abc123";
const LOGIN_CREDENTIAL = "enrolled-credential";

// The one device the relay stubs report. Declared here so both the
// service and the login helpers can answer with it.
const DEVICE = {
  deviceId: "device-uuid",
  name: "Test Mac",
  platform: "darwin",
  createdAt: 1_700_000_000_000,
  lastSeenAt: null,
  online: true,
};

// A fetch that answers the token endpoint with a JWT carrying LOGIN_SUB
// and the enroll route with LOGIN_CREDENTIAL. The flows that never reach
// the exchange (state mismatch, timeout) never call it.
function loginFetch() {
  return recordingFetch((url) => {
    if (url === CONFIG.tokenUrl) {
      return json({ access_token: jwtWithSub(LOGIN_SUB) });
    }
    if (url.endsWith(RELAY_ROUTES.enroll.path)) {
      return json({ credential: LOGIN_CREDENTIAL, device: DEVICE });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }).fetchImpl;
}

// Runs the loopback login flow with the constant config, device identity,
// platform and login fetch, so each assertion states only the store it
// writes to, how the browser behaves, and any timeout it varies.
function runLogin({ store, openBrowser, timeoutMs }) {
  return runLoginFlow({
    config: CONFIG,
    deviceId: "device-uuid",
    deviceName: "My Mac",
    platform: "darwin",
    openBrowser,
    service: createAccountService({
      baseUrl: CONFIG.relayUrl,
      fetchImpl: loginFetch(),
    }),
    store,
    fetchImpl: loginFetch(),
    timeoutMs,
  });
}

// True when a TCP connection to host:port establishes within the timeout,
// false when it is refused or times out. Proves the loopback server is
// reachable on 127.0.0.1 while a routable address is not.
function canConnect(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    let done = false;
    const settle = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

// A non-internal IPv4 address of this machine, or null when it is
// loopback-only (common in headless CI). The routable-bind probe is
// skipped when null.
function nonLoopbackIpv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

const passed = [];
async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("account layer proof\n");

  await check(
    "pkce: verifier is 43-128 base64url chars and challenge is S256(verifier)",
    () => {
      for (let i = 0; i < 50; i += 1) {
        const { verifier, challenge } = generatePkcePair();
        assert.match(
          verifier,
          /^[A-Za-z0-9_-]{43,128}$/,
          "verifier is not base64url in the RFC length range",
        );
        const expected = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        assert.equal(challenge, expected, "challenge is not base64url(sha256)");
      }
    },
  );

  await check(
    "pkce: buildAuthorizeUrl carries the full RFC 8252 + 7636 param set",
    () => {
      const state = generateState();
      const url = new URL(
        buildAuthorizeUrl(CONFIG, {
          redirectUri: "http://127.0.0.1:5555/callback",
          challenge: "the-challenge",
          state,
        }),
      );
      const q = url.searchParams;
      assert.equal(url.origin + url.pathname, "https://auth.test/authorize");
      assert.equal(q.get("response_type"), "code");
      assert.equal(q.get("client_id"), "client-abc");
      assert.equal(q.get("redirect_uri"), "http://127.0.0.1:5555/callback");
      assert.equal(q.get("scope"), "openid profile");
      assert.equal(q.get("state"), state);
      assert.equal(q.get("code_challenge"), "the-challenge");
      assert.equal(q.get("code_challenge_method"), "S256");
    },
  );

  await check(
    "config: isConfigured is false until every required field is set",
    () => {
      assert.equal(isConfigured(CONFIG), true);
      const empty = resolveServiceConfig({});
      assert.equal(isConfigured(empty), false);
      assert.equal(empty.scopes, "openid profile email", "default scopes lost");
      const missingClient = resolveServiceConfig({
        SM_ACCOUNT_RELAY_URL: "https://relay.test",
        SM_ACCOUNT_OAUTH_AUTHORIZE_URL: "https://auth.test/authorize",
        SM_ACCOUNT_OAUTH_TOKEN_URL: "https://auth.test/token",
      });
      assert.equal(isConfigured(missingClient), false);
    },
  );

  await check(
    "pkce: parseRedirectQuery extracts code+state and surfaces an error param",
    () => {
      const ok = parseRedirectQuery("/callback?code=the-code&state=the-state");
      assert.deepEqual(ok, { code: "the-code", state: "the-state" });
      const denied = parseRedirectQuery("/callback?error=access_denied");
      assert.deepEqual(denied, { error: "access_denied" });
      const partial = parseRedirectQuery("/callback?code=only-code");
      assert.ok("error" in partial, "a missing state should surface an error");
    },
  );

  await check(
    "tokenExchange: posts the PKCE grant form and returns the access_token",
    async () => {
      const { fetchImpl, calls } = recordingFetch(() =>
        json({ access_token: "the-access-token", token_type: "Bearer" }),
      );
      const token = await exchangeCodeForToken(CONFIG, {
        code: "auth-code",
        verifier: "the-verifier",
        redirectUri: "http://127.0.0.1:5555/callback",
        fetchImpl,
      });
      assert.equal(token, "the-access-token");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://auth.test/token");
      assert.equal(calls[0].init.method, "POST");
      assert.match(
        calls[0].init.headers["content-type"],
        /application\/x-www-form-urlencoded/,
      );
      const form = new URLSearchParams(calls[0].init.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "auth-code");
      assert.equal(form.get("code_verifier"), "the-verifier");
      assert.equal(form.get("client_id"), "client-abc");
      assert.equal(form.get("redirect_uri"), "http://127.0.0.1:5555/callback");
    },
  );

  await check("tokenExchange: throws on a non-2xx token response", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response("nope", { status: 400 }),
    );
    await assert.rejects(
      () =>
        exchangeCodeForToken(CONFIG, {
          code: "c",
          verifier: "v",
          redirectUri: "http://127.0.0.1:1/callback",
          fetchImpl,
        }),
      /token exchange failed with status 400/,
    );
  });

  await check(
    "service: enroll hits the enroll route with the login-token bearer and an EnrollRequest body",
    async () => {
      const { fetchImpl, calls } = recordingFetch(() =>
        json({ credential: "device-credential", device: DEVICE }),
      );
      const service = createAccountService({
        baseUrl: "https://relay.test",
        fetchImpl,
      });
      const result = await service.enroll("login-token", {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
      });
      assert.equal(result.credential, "device-credential");
      assert.deepEqual(result.device, DEVICE);
      assert.equal(
        calls[0].url,
        "https://relay.test" + RELAY_ROUTES.enroll.path,
      );
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.authorization, "Bearer login-token");
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
        baseUrl: "https://relay.test",
        fetchImpl,
      });
      const devices = await service.listDevices("device-credential");
      assert.deepEqual(devices, [DEVICE]);
      assert.equal(
        calls[0].url,
        "https://relay.test" + RELAY_ROUTES.listDevices.path,
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
        baseUrl: "https://relay.test",
        fetchImpl,
      });
      await service.revoke("device-credential", "other device/id");
      assert.equal(
        calls[0].url,
        "https://relay.test" +
          RELAY_ROUTES.revokeDevice.path("other device/id"),
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
        baseUrl: "https://relay.test",
        fetchImpl,
      });
      const ticket = await service.mintTicket("device-credential");
      assert.equal(ticket.ticket, "the-ticket");
      assert.equal(
        calls[0].url,
        "https://relay.test" + RELAY_ROUTES.mintTicket.path,
      );
      assert.equal(calls[0].init.method, "POST");
      assert.equal(
        calls[0].init.headers.authorization,
        "Bearer device-credential",
      );
    },
  );

  await check(
    "service: the auth tier differs, enroll under the login token and the rest under the credential",
    async () => {
      const responder = (url) => {
        if (url.endsWith(RELAY_ROUTES.enroll.path)) {
          return json({ credential: "device-credential", device: DEVICE });
        }
        return json({ devices: [DEVICE] });
      };
      const { fetchImpl, calls } = recordingFetch(responder);
      const service = createAccountService({
        baseUrl: "https://relay.test",
        fetchImpl,
      });
      await service.enroll("login-token", {
        deviceId: "device-uuid",
        name: "Test Mac",
        platform: "darwin",
      });
      await service.listDevices("device-credential");
      const enrollAuth = calls[0].init.headers.authorization;
      const listAuth = calls[1].init.headers.authorization;
      assert.equal(enrollAuth, "Bearer login-token");
      assert.equal(listAuth, "Bearer device-credential");
      assert.notEqual(enrollAuth, listAuth, "enroll and list share a bearer");
    },
  );

  await check(
    "service: a non-2xx with an ErrorBody throws the relay's error message",
    async () => {
      const { fetchImpl } = recordingFetch(() =>
        json({ error: "device revoked" }, 403),
      );
      const service = createAccountService({
        baseUrl: "https://relay.test",
        fetchImpl,
      });
      await assert.rejects(
        () => service.listDevices("device-credential"),
        /device revoked/,
      );
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
      "login: the full loopback flow stores the credential with the derived accountId and deviceName",
      async () => {
        const store = createAccountStore({
          filePath: join(tmp, "login.json"),
          cipher: PLAINTEXT_CIPHER,
        });
        const result = await runLogin({
          store,
          openBrowser: async (authorizeUrl) => {
            const u = new URL(authorizeUrl);
            const redirect = u.searchParams.get("redirect_uri");
            const state = u.searchParams.get("state");
            await httpGetDone(
              `${redirect}?code=auth-code&state=${encodeURIComponent(state)}`,
            );
          },
        });
        assert.equal(result.accountId, LOGIN_SUB);
        assert.equal(result.deviceName, "My Mac");
        assert.equal(store.read().credential, LOGIN_CREDENTIAL);
        assert.equal(store.read().accountId, LOGIN_SUB);
      },
    );

    await check(
      "login: the loopback server binds 127.0.0.1 only, reachable there but not on a routable address",
      async () => {
        const store = createAccountStore({
          filePath: join(tmp, "login-bind.json"),
          cipher: PLAINTEXT_CIPHER,
        });
        let loopbackReachable = false;
        let routableReachable = null;
        const result = await runLogin({
          store,
          openBrowser: async (authorizeUrl) => {
            const u = new URL(authorizeUrl);
            const redirect = new URL(u.searchParams.get("redirect_uri"));
            const state = u.searchParams.get("state");
            assert.equal(
              redirect.hostname,
              "127.0.0.1",
              "the redirect URI is not loopback",
            );
            const port = Number(redirect.port);
            loopbackReachable = await canConnect("127.0.0.1", port);
            const routable = nonLoopbackIpv4();
            if (routable) routableReachable = await canConnect(routable, port);
            await httpGetDone(
              `${redirect.origin}/callback?code=auth-code&state=${encodeURIComponent(state)}`,
            );
          },
        });
        assert.equal(result.accountId, LOGIN_SUB);
        assert.ok(
          loopbackReachable,
          "the loopback server was not reachable on 127.0.0.1",
        );
        if (routableReachable !== null) {
          assert.equal(
            routableReachable,
            false,
            "the loopback server was reachable on a routable address",
          );
        }
      },
    );

    await check(
      "login: a state mismatch on the redirect is rejected and stores nothing",
      async () => {
        const store = createAccountStore({
          filePath: join(tmp, "login-badstate.json"),
          cipher: PLAINTEXT_CIPHER,
        });
        await assert.rejects(
          () =>
            runLogin({
              store,
              openBrowser: async (authorizeUrl) => {
                const u = new URL(authorizeUrl);
                const redirect = u.searchParams.get("redirect_uri");
                await httpGetDone(`${redirect}?code=auth-code&state=WRONG`);
              },
            }),
          /state mismatch/,
        );
        assert.equal(
          store.read(),
          null,
          "a mismatched flow must store nothing",
        );
      },
    );

    await check(
      "login: the redirect timeout rejects and closes the server",
      async () => {
        const store = createAccountStore({
          filePath: join(tmp, "login-timeout.json"),
          cipher: PLAINTEXT_CIPHER,
        });
        await assert.rejects(
          () =>
            runLogin({
              store,
              // Never redirects, so only the timeout can settle the flow.
              openBrowser: () => {},
              timeoutMs: 120,
            }),
          /timed out/,
        );
        assert.equal(store.read(), null, "a timed-out flow must store nothing");
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
        // Fill exactly to the 1024 ceiling.
        for (let i = 0; i < 1024; i += 1) grants.grant("acct-1", `peer-${i}`);
        assert.equal(grants.list("acct-1").length, 1024);
        // A NEW peer past the cap is refused rather than growing the file.
        assert.throws(
          () => grants.grant("acct-1", "peer-over"),
          /cannot grant more than 1024/,
        );
        assert.equal(
          grants.list("acct-1").length,
          1024,
          "the cap was exceeded",
        );
        // Re-granting an already-trusted peer at the cap is still a no-op,
        // not a spurious over-cap throw.
        grants.grant("acct-1", "peer-0");
        assert.equal(grants.list("acct-1").length, 1024);
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  await check(
    'login: deriveAccountId reads a JWT sub and returns "" for anything malformed without throwing',
    () => {
      // The happy alg:none path still derives the sub.
      assert.equal(deriveAccountId(jwtWithSub("user_x")), "user_x");
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
      // DeviceInfo is the per-device shape the relay reports and the
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

  await check(
    "envFile: parseDotenv skips comments and blanks, strips quotes, ignores malformed lines, and drops __proto__",
    () => {
      const parsed = parseDotenv(
        [
          "# a comment",
          "",
          "   ",
          "SM_ACCOUNT_RELAY_URL=https://relay.test",
          'QUOTED="double quoted"',
          "SINGLE='single quoted'",
          "no_equals_here",
          "=leading-equals",
          "__proto__=polluted",
        ].join("\n"),
      );
      assert.equal(parsed.SM_ACCOUNT_RELAY_URL, "https://relay.test");
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
    "envFile: mergeServiceEnv lets process.env override the file",
    () => {
      const merged = mergeServiceEnv(
        { SM_ACCOUNT_RELAY_URL: "https://file.example", ONLY_FILE: "f" },
        { SM_ACCOUNT_RELAY_URL: "https://env.example", ONLY_ENV: "e" },
      );
      assert.equal(
        merged.SM_ACCOUNT_RELAY_URL,
        "https://env.example",
        "process.env did not win over the file",
      );
      assert.equal(merged.ONLY_FILE, "f");
      assert.equal(merged.ONLY_ENV, "e");
    },
  );

  console.log(`\naccount layer proof OK (${passed.length} assertions)`);
}

// GET a URL and resolve once the response is fully drained, so the
// loopback server has finished handling the redirect before the stub
// browser returns.
function httpGetDone(url) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      res.resume();
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

main().catch((error) => {
  console.error(`\naccount layer proof FAILED: ${error?.message ?? error}`);
  process.exitCode = 1;
});
