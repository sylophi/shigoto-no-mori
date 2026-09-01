// Durable proof for the web client's window.api bridge (web/bridge/).
// The factory takes every platform fact through injected deps, which is
// what lets this run headlessly under node 22: an in-memory
// localStorage shim, a recording fetch, and no DOM.
//
// Asserts: the bridge surface matches buildApi plus the preload's
// scalar facts (so renderer components mount unmodified), the
// localStorage-backed clientConfig store round-trips and heals corrupt
// JSON, the per-browser deviceId is stable and matches DeviceIdSchema,
// enroll exchanges the Clerk session token for a credential with
// platform "web" and persists the enc:false envelope, sign-out
// revokes this device then clears the envelope, read-classified OS-bound
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
import { DeviceIdSchema } from "@shared/hub/protocol";
import { createWebBridge } from "../web/bridge/createWebBridge.ts";
import { defaultWebDeviceName } from "../web/account/deviceName.ts";
import {
  NO_STRUCTURAL_STUB,
  stubValueFor,
} from "../web/bridge/stubDefaults.ts";
import { fakeSessionJwt, makeProof } from "./lib/checkKit.mjs";

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

const HUB_URL = "https://hub.example.test";
const PUBLISHABLE_KEY = "pk_test_check";
const CONFIGURED_ENV = {
  SM_ACCOUNT_HUB_URL: HUB_URL,
  SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
};
const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function makeDeps(overrides = {}) {
  return {
    localStorage: memoryStorage(),
    env: CONFIGURED_ENV,
    userAgent: CHROME_MAC_UA,
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

const STORED_ENVELOPE = JSON.stringify({
  v: 1,
  enc: false,
  credential: "cred-stored",
  accountId: "acct_stored",
  deviceName: "Stored browser",
});

// ---- harness (scripts/lib/checkKit.mjs) ----

const { check, done, fail } = makeProof("web bridge proof");

async function main() {
  console.log("web bridge proof\n");

  await check(
    "surface: the bridge exposes exactly buildApi's namespaces and members plus deviceId, appVersion, clerkPublishableKey, isDev and isElectron",
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
          "clerkPublishableKey",
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
      // The Clerk mount decision, resolved from the baked env exactly
      // like the desktop preload resolves it from argv.
      assert.equal(bridge.api.clerkPublishableKey, PUBLISHABLE_KEY);
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
    'enroll: exchanges the Clerk session token for a credential with platform "web" under this deviceId, and persists the enc:false envelope',
    async (track) => {
      const localStorage = memoryStorage();
      const requests = [];
      const fetchImpl = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === `${HUB_URL}/devices/enroll`) {
          const body = JSON.parse(init.body);
          assert.equal(body.platform, "web");
          assert.equal(body.deviceId, deviceId);
          assert.equal(body.name, defaultWebDeviceName(CHROME_MAC_UA));
          // The enroll bearer is the session token itself, never a
          // derived or stored value.
          assert.equal(
            init.headers.authorization,
            `Bearer ${fakeSessionJwt("acct_1")}`,
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
        if (url === `${HUB_URL}/tickets`) {
          // The post-enroll hub refresh mints here, and failing it plainly
          // parks the supervisor in backoff until the tracked stop.
          return jsonResponse(500, { error: "no hub in this check" });
        }
        throw new Error(`unexpected fetch in enroll check: ${url}`);
      };
      const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
      track(() => bridge.stop());
      const deviceId = bridge.api.deviceId;

      const status = await bridge.api.account.enroll(fakeSessionJwt("acct_1"));
      assert.equal(status.signedIn, true);
      assert.equal(status.accountId, "acct_1");

      const envelope = JSON.parse(localStorage.getItem("sm.web.account"));
      assert.deepEqual(envelope, {
        v: 1,
        enc: false,
        credential: "cred-1",
        accountId: "acct_1",
        deviceName: defaultWebDeviceName(CHROME_MAC_UA),
      });
      // Auth state survives a "reload": a fresh bridge over the same
      // storage reads the same signed-in status.
      const reloaded = createWebBridge(makeDeps({ localStorage, fetchImpl }));
      const after = await reloaded.api.account.status();
      assert.equal(after.signedIn, true);
      assert.equal(after.accountId, "acct_1");
    },
  );

  await check(
    "sign-out: revokes THIS device on the hub, clears the envelope, and still signs out when the revoke fails",
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
        `${HUB_URL}/devices/${encodeURIComponent(bridge.api.deviceId)}`,
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
    "unconfigured: status reports configured false, enroll rejects, and the hub refresh yields the typed state with a stopped socket",
    async (track) => {
      const bridge = createWebBridge(makeDeps({ env: {} }));
      track(() => bridge.stop());
      const status = await bridge.api.account.status();
      assert.equal(status.configured, false);
      assert.equal(bridge.api.clerkPublishableKey, "");
      await assert.rejects(
        bridge.api.account.enroll(fakeSessionJwt("acct_1")),
        /not configured/,
      );
      await bridge.refreshHub();
      assert.deepEqual(bridge.webAccess.get(), { kind: "unconfigured" });
      const hub = await bridge.api.hub.status();
      assert.notEqual(hub.socket.phase, "connecting");
      assert.notEqual(hub.socket.phase, "backoff");
      assert.deepEqual(hub.onlineDeviceIds, []);
    },
  );

  await check(
    "refused: a hub 403 on the ticket mint yields the typed blocked state and stops the supervisor after one mint, no retry loop",
    async (track) => {
      const localStorage = memoryStorage();
      localStorage.setItem("sm.web.account", STORED_ENVELOPE);
      let mints = 0;
      const fetchImpl = async (input) => {
        const url = String(input);
        if (url === `${HUB_URL}/tickets`) {
          mints += 1;
          return jsonResponse(403, { error: "malformed ticket" });
        }
        throw new Error(`unexpected fetch in blocked check: ${url}`);
      };
      const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
      track(() => bridge.stop());
      await bridge.refreshHub();
      await waitFor(
        () => bridge.webAccess.get().kind === "blocked",
        "the blocked access state",
      );
      assert.match(bridge.webAccess.get().message, /malformed ticket/);
      // Longer than the supervisor's first backoff rung: a retry loop
      // would have minted again by now.
      await delay(1_300);
      assert.equal(mints, 1, "the blocked deployment was redialed");
      const hub = await bridge.api.hub.status();
      assert.equal(hub.socket.phase, "stopped");
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

  done();
}

main().catch(fail);
