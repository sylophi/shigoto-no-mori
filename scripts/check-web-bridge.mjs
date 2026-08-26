// Durable proof for the web client's window.api bridge (web/bridge/).
// The factory takes every platform fact through injected deps, which is
// what lets this run headlessly under node 22: in-memory localStorage
// and sessionStorage shims, a recording fetch, and no DOM.
//
// Asserts: the bridge surface matches buildApi plus the preload's
// scalar facts (so renderer components mount unmodified), the
// localStorage-backed clientConfig store round-trips and heals corrupt
// JSON, the per-browser deviceId is stable and matches DeviceIdSchema,
// the redirect login flow carries PKCE (S256) and state and enrolls
// with platform "web", a state mismatch rejects, sign-out revokes this
// device then clears the envelope, explicitly read-classified OS-bound
// channels answer structural stub defaults while every mutation-shaped
// or unclassified channel REJECTS (fail-closed, including enum/union
// outputs the walker refuses to fabricate), the step-6 remote flips
// (fs, the projects/packageScripts preference writes,
// globalConfig.writeDeviceSettings) keep rejecting as mutating-rejects,
// the preflight grant read answers the structural granted:false rather
// than a fabricated grant, shell.openExternal reaches
// the injected opener, and the unconfigured/origin-blocked access
// states are typed and terminal rather than a supervisor retry loop.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "web:bridge:check".
import assert from "node:assert/strict";
import { buildApi } from "@shared/ipc/client";
import { DeviceIdSchema } from "@shared/relay/protocol";
import { createWebBridge } from "../web/bridge/createWebBridge.ts";
import { defaultWebDeviceName } from "../web/account/deviceName.ts";
import {
  NO_STRUCTURAL_STUB,
  stubValueFor,
} from "../web/bridge/stubDefaults.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- shims and fixtures ----

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const RELAY_URL = "https://relay.example.test";
const CONFIGURED_ENV = {
  SM_ACCOUNT_RELAY_URL: RELAY_URL,
  SM_ACCOUNT_OAUTH_AUTHORIZE_URL: "https://auth.example.test/authorize",
  SM_ACCOUNT_OAUTH_TOKEN_URL: "https://auth.example.test/token",
  SM_ACCOUNT_OAUTH_CLIENT_ID: "client123",
};
const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ORIGIN = "https://sm.example.test";

function makeDeps(overrides = {}) {
  return {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    env: CONFIGURED_ENV,
    userAgent: CHROME_MAC_UA,
    origin: ORIGIN,
    navigate: () => {},
    openExternal: () => {},
    isDev: true,
    appVersion: "0.0.0-check",
    // Anything unstubbed must fail loudly, not hit the network.
    fetchImpl: () =>
      Promise.reject(new TypeError("fetch is not stubbed for this route")),
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A fake JWT whose payload carries the sub claim, unsigned on purpose:
// deriveAccountIdFromToken never verifies, it only reads for display.
function jwtSegment(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeJwt(sub) {
  return `${jwtSegment({ alg: "none" })}.${jwtSegment({ sub })}.sig`;
}

const STORED_ENVELOPE = JSON.stringify({
  v: 1,
  enc: false,
  credential: "cred-stored",
  accountId: "acct_stored",
  deviceName: "Stored browser",
});

function base64UrlOfDigest(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

// ---- harness (mirrors check-web-relay.mjs) ----

const passed = [];
async function check(name, fn) {
  const cleanups = [];
  const track = (cleanup) => {
    cleanups.push(cleanup);
    return cleanup;
  };
  try {
    await fn(track);
  } finally {
    for (const cleanup of cleanups.toReversed()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- cleanups run serially by design
        await cleanup();
      } catch {
        // A cleanup failure must not mask the test outcome.
      }
    }
  }
  passed.push(name);
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("web bridge proof\n");

  await check(
    "surface: the bridge exposes exactly buildApi's namespaces and members plus deviceId, appVersion, isDev and isElectron",
    () => {
      const bridge = createWebBridge(makeDeps());
      const dummy = {
        invoke: () => Promise.resolve(undefined),
        subscribe: () => () => {},
      };
      const golden = buildApi({ host: dummy, client: dummy });
      assert.deepEqual(
        Object.keys(bridge.api).toSorted(),
        [
          ...Object.keys(golden),
          "deviceId",
          "appVersion",
          "isDev",
          "isElectron",
        ].toSorted(),
        "the bridge's top-level keys drifted from the preload surface",
      );
      for (const [ns, members] of Object.entries(golden)) {
        assert.deepEqual(
          Object.keys(bridge.api[ns]).toSorted(),
          Object.keys(members).toSorted(),
          `namespace ${ns} drifted`,
        );
        for (const key of Object.keys(members)) {
          assert.equal(
            typeof bridge.api[ns][key],
            "function",
            `${ns}.${key} is not callable`,
          );
        }
      }
      assert.equal(typeof bridge.api.deviceId, "string");
      assert.equal(typeof bridge.api.appVersion, "string");
      assert.equal(typeof bridge.api.isDev, "boolean");
      // The app-only gate must read false here, or shared pages would
      // mount port-forward controls the browser cannot honor.
      assert.equal(bridge.api.isElectron, false);
    },
  );

  await check(
    "deviceId: stable across bridges over the same storage, schema-valid, and distinct per browser profile",
    () => {
      const localStorage = memoryStorage();
      const first = createWebBridge(makeDeps({ localStorage }));
      const second = createWebBridge(makeDeps({ localStorage }));
      assert.equal(first.api.deviceId, second.api.deviceId);
      assert.equal(DeviceIdSchema.safeParse(first.api.deviceId).success, true);
      assert.match(
        first.api.deviceId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "the minted deviceId is not a well-formed UUID",
      );
      const other = createWebBridge(makeDeps());
      assert.notEqual(other.api.deviceId, first.api.deviceId);
      // A mangled stored id is replaced rather than trusted.
      localStorage.setItem("sm.web.deviceId", "not-a-uuid");
      const healed = createWebBridge(makeDeps({ localStorage }));
      assert.notEqual(healed.api.deviceId, "not-a-uuid");
      assert.equal(DeviceIdSchema.safeParse(healed.api.deviceId).success, true);
    },
  );

  await check(
    "clientConfig: reads default to {}, writes round-trip through localStorage, and corrupt JSON heals to defaults",
    async () => {
      const localStorage = memoryStorage();
      const bridge = createWebBridge(makeDeps({ localStorage }));
      assert.deepEqual(await bridge.api.clientConfig.read(), {});
      await bridge.api.clientConfig.write({ theme: "dark", doubutsu: false });
      assert.deepEqual(await bridge.api.clientConfig.read(), {
        theme: "dark",
        doubutsu: false,
      });
      assert.deepEqual(
        JSON.parse(localStorage.getItem("sm.web.clientConfig")),
        { theme: "dark", doubutsu: false },
        "the persisted document drifted from the written config",
      );
      localStorage.setItem("sm.web.clientConfig", "{corrupt");
      assert.deepEqual(await bridge.api.clientConfig.read(), {});
    },
  );

  await check(
    "stubs: read-classified channels answer structural defaults, the previewTheme allowlist entry resolves, and stub subscriptions unsubscribe cleanly",
    async () => {
      const bridge = createWebBridge(makeDeps());
      // mutating:false reads stub to structural emptiness.
      assert.deepEqual(await bridge.api.projects.list(), []);
      assert.deepEqual(await bridge.api.worktrees.list("p1"), []);
      // Real handler, not a stub, but the same empty answer.
      assert.deepEqual(await bridge.api.account.listGrantedDevices(), []);
      // The one allowlisted channel: ThemeProvider fires it per theme
      // change and a browser has no native chrome to sync.
      assert.equal(await bridge.api.window.previewTheme("dark"), undefined);
      const unsubscribe = bridge.api.git.onRefsRefreshed(() => {});
      assert.equal(typeof unsubscribe, "function");
      unsubscribe();
      // The walker itself: without fabrication a union or bounded
      // string yields the sentinel, with fabrication (allowlist only)
      // it still parses.
      const { z } = await import("zod");
      const union = z.discriminatedUnion("t", [
        z.object({ t: z.literal("a"), n: z.number().int() }),
        z.object({ t: z.literal("b") }),
      ]);
      assert.equal(
        stubValueFor(union, { fabricateArms: false }),
        NO_STRUCTURAL_STUB,
      );
      assert.equal(
        stubValueFor(z.string().min(1), { fabricateArms: false }),
        NO_STRUCTURAL_STUB,
      );
      assert.equal(
        union.safeParse(stubValueFor(union, { fabricateArms: true })).success,
        true,
      );
      // A nested enum blocks the whole object structurally.
      assert.equal(
        stubValueFor(z.object({ state: z.enum(["granted", "denied"]) }), {
          fabricateArms: false,
        }),
        NO_STRUCTURAL_STUB,
      );
    },
  );

  await check(
    "fail-closed: mutation-shaped and unclassified channels reject on the web instead of reporting stub success",
    async () => {
      const bridge = createWebBridge(makeDeps());
      const refused = /not available in the browser/;
      // The review's live findings: each of these previously resolved a
      // success-shaped stub ({ok:true}, a blank Worktree, undefined, a
      // blank project, a blank runId).
      await assert.rejects(
        bridge.api.worktrees.delete({ projectId: "p", worktreeId: "w" }),
        refused,
      );
      await assert.rejects(
        bridge.api.worktrees.push({ projectId: "p", worktreeId: "w" }),
        refused,
      );
      await assert.rejects(bridge.api.runtime.nuke(), refused);
      await assert.rejects(bridge.api.projects.add("/tmp/x"), refused);
      await assert.rejects(
        bridge.api.scripts.run({ projectId: "p", worktreeId: "w" }),
        refused,
      );
      // Local-only channels that never classified themselves as reads
      // reject too, which also covers the affirmative-biased enum their
      // outputs would otherwise stub to (cli.status's first arm is
      // "installed").
      await assert.rejects(bridge.api.cli.status(), refused);
      await assert.rejects(bridge.api.updater.get(), refused);
      // The port-forward engine binds real TCP listeners, so its whole
      // client-scoped surface must refuse on the web (the UI never
      // mounts there, gated on isElectron, but the wire is the wall).
      await assert.rejects(bridge.api.portForward.list(), refused);
      await assert.rejects(
        bridge.api.portForward.start({ deviceId: "d1", remotePort: 3000 }),
        refused,
      );
      // The step-6 flips (v2 slice B): these were unclassified-rejects
      // before (remote:false, no mutating tag) and are mutating-rejects
      // now (remote:true, mutating:true). Either way the loopback wire
      // must refuse them: the fs reads because they ride the command
      // grant, the preference/registry writes and the device-settings
      // write because they are commands.
      await assert.rejects(bridge.api.fs.listDirectory("/tmp"), refused);
      await assert.rejects(bridge.api.fs.scanForGitRepos("/tmp"), refused);
      await assert.rejects(bridge.api.fs.isGitRepo("/tmp"), refused);
      await assert.rejects(bridge.api.fs.stat("/tmp"), refused);
      await assert.rejects(bridge.api.fs.listEntries("/tmp"), refused);
      await assert.rejects(bridge.api.projects.remove("p1"), refused);
      await assert.rejects(bridge.api.projects.setSort("name"), refused);
      await assert.rejects(bridge.api.projects.toggleCollapsed("p1"), refused);
      await assert.rejects(
        bridge.api.packageScripts.setSort("p1", "alphabetical"),
        refused,
      );
      await assert.rejects(
        bridge.api.globalConfig.writeDeviceSettings({ githubCli: false }),
        refused,
      );
      // The preflight grant read is the permission-shaped query the
      // stub walker exists to protect: it may answer, but ONLY the
      // structural (never fabricated) verdict, and structural emptiness
      // for { granted: boolean } is granted:false. A web loopback must
      // never manufacture a grant.
      assert.deepEqual(await bridge.api.remoteAccess.commandAccess(), {
        granted: false,
      });
      // The real refuse-all handlers name their refusal precisely.
      await assert.rejects(
        bridge.api.account.grantCommands("d1"),
        /cannot grant command access/,
      );
      await assert.rejects(
        bridge.api.account.revokeCommands("d1"),
        /cannot change command access/,
      );
    },
  );

  await check(
    "shell: openExternal reaches the injected opener and showItemInFolder is a harmless no-op",
    async (track) => {
      const opened = [];
      const bridge = createWebBridge(
        makeDeps({ openExternal: (url) => opened.push(url) }),
      );
      track(() => bridge.stop());
      await bridge.api.shell.openExternal("https://example.com/page");
      assert.deepEqual(opened, ["https://example.com/page"]);
      assert.equal(
        await bridge.api.shell.showItemInFolder("/somewhere"),
        undefined,
      );
    },
  );

  await check(
    "login begin: signIn redirects to an authorize URL carrying PKCE S256 and state, with the pair parked in sessionStorage",
    async () => {
      const sessionStorage = memoryStorage();
      const navigated = [];
      const bridge = createWebBridge(
        makeDeps({ sessionStorage, navigate: (url) => navigated.push(url) }),
      );
      await bridge.api.account.signIn();
      assert.equal(navigated.length, 1, "signIn did not navigate exactly once");
      const url = new URL(navigated[0]);
      assert.equal(
        url.origin + url.pathname,
        "https://auth.example.test/authorize",
      );
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), "client123");
      assert.equal(
        url.searchParams.get("redirect_uri"),
        `${ORIGIN}/auth/callback`,
      );
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const pending = JSON.parse(sessionStorage.getItem("sm.web.loginPending"));
      assert.equal(url.searchParams.get("state"), pending.state);
      // The challenge in the URL is the S256 transform of the parked
      // verifier, so the callback can complete the exchange.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(pending.verifier),
      );
      assert.equal(
        url.searchParams.get("code_challenge"),
        base64UrlOfDigest(new Uint8Array(digest)),
      );
    },
  );

  await check(
    'login complete: the callback exchanges the code with the parked verifier, enrolls platform "web" under this deviceId, and persists the enc:false envelope',
    async (track) => {
      const sessionStorage = memoryStorage();
      const localStorage = memoryStorage();
      const navigated = [];
      const requests = [];
      const fetchImpl = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === "https://auth.example.test/token") {
          const form = new URLSearchParams(init.body);
          assert.equal(form.get("grant_type"), "authorization_code");
          assert.equal(form.get("redirect_uri"), `${ORIGIN}/auth/callback`);
          return jsonResponse(200, { access_token: fakeJwt("acct_1") });
        }
        if (url === `${RELAY_URL}/devices/enroll`) {
          const body = JSON.parse(init.body);
          assert.equal(body.platform, "web");
          assert.equal(body.deviceId, deviceId);
          assert.equal(body.name, defaultWebDeviceName(CHROME_MAC_UA));
          assert.equal(
            init.headers.authorization,
            `Bearer ${fakeJwt("acct_1")}`,
          );
          return jsonResponse(200, {
            credential: "cred-1",
            device: {
              deviceId: body.deviceId,
              name: body.name,
              platform: body.platform,
              createdAt: Date.now(),
              lastSeenAt: null,
              online: false,
            },
          });
        }
        if (url === `${RELAY_URL}/tickets`) {
          // The post-login relay refresh mints here; failing it plainly
          // parks the supervisor in backoff until the tracked stop.
          return jsonResponse(500, { error: "no relay in this check" });
        }
        throw new Error(`unexpected fetch in login check: ${url}`);
      };
      const bridge = createWebBridge(
        makeDeps({
          sessionStorage,
          localStorage,
          fetchImpl,
          navigate: (url) => navigated.push(url),
        }),
      );
      track(() => bridge.stop());
      const deviceId = bridge.api.deviceId;

      await bridge.api.account.signIn();
      const authorize = new URL(navigated[0]);
      const pendingBefore = JSON.parse(
        sessionStorage.getItem("sm.web.loginPending"),
      );
      const status = await bridge.completeLoginRedirect(
        `${ORIGIN}/auth/callback?code=code-1&state=${authorize.searchParams.get("state")}`,
      );
      assert.equal(status.signedIn, true);
      assert.equal(status.accountId, "acct_1");

      const tokenCall = requests.find(
        (r) => r.url === "https://auth.example.test/token",
      );
      const form = new URLSearchParams(tokenCall.init.body);
      assert.equal(form.get("code"), "code-1");
      assert.equal(
        form.get("code_verifier"),
        pendingBefore.verifier,
        "the exchange did not present the parked verifier",
      );

      const envelope = JSON.parse(localStorage.getItem("sm.web.account"));
      assert.deepEqual(envelope, {
        v: 1,
        enc: false,
        credential: "cred-1",
        accountId: "acct_1",
        deviceName: defaultWebDeviceName(CHROME_MAC_UA),
      });
      // The pending record is single-use.
      assert.equal(sessionStorage.getItem("sm.web.loginPending"), null);
      // Auth state survives a "reload": a fresh bridge over the same
      // storage reads the same signed-in status.
      const reloaded = createWebBridge(makeDeps({ localStorage, fetchImpl }));
      const after = await reloaded.api.account.status();
      assert.equal(after.signedIn, true);
      assert.equal(after.accountId, "acct_1");
    },
  );

  await check(
    "login state mismatch: a redirect carrying a foreign state rejects and persists nothing",
    async () => {
      const sessionStorage = memoryStorage();
      const localStorage = memoryStorage();
      const bridge = createWebBridge(
        makeDeps({ sessionStorage, localStorage, navigate: () => {} }),
      );
      await bridge.api.account.signIn();
      await assert.rejects(
        bridge.completeLoginRedirect(
          `${ORIGIN}/auth/callback?code=code-1&state=not-the-state`,
        ),
        /state mismatch/,
      );
      assert.equal(localStorage.getItem("sm.web.account"), null);
      // The consumed pending record means a replayed callback cannot
      // retry either.
      await assert.rejects(
        bridge.completeLoginRedirect(
          `${ORIGIN}/auth/callback?code=code-1&state=whatever`,
        ),
        /no sign-in in progress/,
      );
    },
  );

  await check(
    "sign-out: revokes THIS device on the relay, clears the envelope, and still signs out when the revoke fails",
    async (track) => {
      const localStorage = memoryStorage();
      localStorage.setItem("sm.web.account", STORED_ENVELOPE);
      const deletes = [];
      const fetchImpl = async (input, init = {}) => {
        const url = String(input);
        if (init.method === "DELETE") {
          deletes.push({ url, auth: init.headers.authorization });
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch in sign-out check: ${url}`);
      };
      const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
      track(() => bridge.stop());
      await bridge.api.account.signOut();
      assert.equal(deletes.length, 1);
      assert.equal(
        deletes[0].url,
        `${RELAY_URL}/devices/${encodeURIComponent(bridge.api.deviceId)}`,
      );
      assert.equal(deletes[0].auth, "Bearer cred-stored");
      assert.equal(localStorage.getItem("sm.web.account"), null);
      assert.equal((await bridge.api.account.status()).signedIn, false);

      // The failure path: revoke rejects, local sign-out still lands.
      const second = memoryStorage();
      second.setItem("sm.web.account", STORED_ENVELOPE);
      const failing = createWebBridge(
        makeDeps({
          localStorage: second,
          fetchImpl: () => Promise.reject(new TypeError("offline")),
        }),
      );
      track(() => failing.stop());
      await failing.api.account.signOut();
      assert.equal(second.getItem("sm.web.account"), null);
    },
  );

  await check(
    "unconfigured: status reports configured false, signIn rejects, and the relay refresh yields the typed state with a stopped socket",
    async (track) => {
      const bridge = createWebBridge(makeDeps({ env: {} }));
      track(() => bridge.stop());
      const status = await bridge.api.account.status();
      assert.equal(status.configured, false);
      await assert.rejects(bridge.api.account.signIn(), /not configured/);
      await bridge.refreshRelay();
      assert.deepEqual(bridge.webAccess.get(), { kind: "unconfigured" });
      const relay = await bridge.api.relay.status();
      assert.notEqual(relay.socket.phase, "connecting");
      assert.notEqual(relay.socket.phase, "backoff");
      assert.deepEqual(relay.onlineDeviceIds, []);
    },
  );

  await check(
    "origin blocked: a relay 403 on the ticket mint yields the typed blocked state and stops the supervisor after one mint, no retry loop",
    async (track) => {
      const localStorage = memoryStorage();
      localStorage.setItem("sm.web.account", STORED_ENVELOPE);
      let mints = 0;
      const fetchImpl = async (input) => {
        const url = String(input);
        if (url === `${RELAY_URL}/tickets`) {
          mints += 1;
          return jsonResponse(403, { error: "origin not allowed" });
        }
        throw new Error(`unexpected fetch in blocked check: ${url}`);
      };
      const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
      track(() => bridge.stop());
      await bridge.refreshRelay();
      await waitFor(
        () => bridge.webAccess.get().kind === "blocked",
        "the blocked access state",
      );
      assert.match(bridge.webAccess.get().message, /origin not allowed/);
      // Longer than the supervisor's first backoff rung: a retry loop
      // would have minted again by now.
      await delay(1_300);
      assert.equal(mints, 1, "the blocked deployment was redialed");
      const relay = await bridge.api.relay.status();
      assert.equal(relay.socket.phase, "stopped");
    },
  );

  await check(
    "device names: the user-agent default is short and human-readable across the major browsers",
    () => {
      assert.equal(defaultWebDeviceName(CHROME_MAC_UA), "Chrome on macOS");
      assert.equal(
        defaultWebDeviceName(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
        ),
        "Firefox on Windows",
      );
      assert.equal(
        defaultWebDeviceName(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        ),
        "Safari on iOS",
      );
      assert.equal(defaultWebDeviceName("weird/0.0"), "Browser");
    },
  );

  console.log(`\nweb bridge proof OK (${passed.length} assertions)`);
}

main().catch((error) => {
  console.error(`\nweb bridge proof FAILED: ${error?.message ?? error}`);
  process.exitCode = 1;
});
