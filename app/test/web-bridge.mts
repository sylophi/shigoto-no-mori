// Durable proof for the web client's bridge (web/ipc/), which builds the
// tab's page api (renderer/lib/runtime/pageApi.tsx).
// The factory takes every platform fact through injected deps, which is
// what lets this run headlessly under node 22: an in-memory
// localStorage shim, a recording fetch, and no DOM.
//
// Asserts: the page api's surface is every contract module by name, the
// runtime's own peerApi, run, listen, pushes and view, and the preload's
// scalar facts (so renderer components mount unmodified), the
// localStorage-backed clientConfig store round-trips, heals corrupt
// JSON and turns an Each launch rotation once per tab, the
// per-browser deviceId is stable and matches DeviceIdSchema (two
// fresh tabs mint one under the account lock and enroll it, a stored
// one boots without it), enroll exchanges the Clerk session token for
// a credential with platform "web" and persists the enc:false
// envelope, sign-out revokes this device then clears the envelope
// (removing it when storage refuses the remainder, failing when it
// refuses the removal too, as an enroll fails that can't keep its
// credential), a concurrent enroll or sign-out rides the one under
// way (a failed one not kept), two tabs enrolling at once enroll once and keep the credential the hub holds,
// the shared settings another tab wrote reach this tab's watch,
// read-classified OS-bound
// channels answer structural stub defaults while every mutation-shaped
// or unclassified channel REJECTS (fail-closed, including enum/union
// outputs the walker refuses to fabricate), the remote reads and writes
// (fs, the projects/packageScripts preference writes,
// globalConfig.writeDeviceSettings) keep rejecting as mutating-rejects,
// the status snapshot reports no peer's command access it was not told
// (never a fabricated one), shell.openExternal reaches
// the injected opener, an unconfigured build keeps the socket stopped,
// and a device hub refusal blocks the supervisor (terminal, no retry
// loop) the way it does on the desktop.
//
// Run: pnpm test web-bridge.
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { it } from "vitest";
import { allContractModules } from "@shigomori/contracts/allModules";
import { nameOf } from "@shigomori/contracts/contract";
import { gitContract } from "@shigomori/contracts/modules/git";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { sharedSettingsContract } from "@shigomori/contracts/modules/sharedSettings";
import { DeviceIdSchema } from "@shigomori/contracts/hubProtocol";
import {
  createWebBridge,
  establishWebDeviceId,
  type WebBridgeDeps,
} from "../web/ipc/register.ts";
import { getWebDeviceId } from "../web/account/deviceId.ts";
import * as Effect from "effect/Effect";
import { createLocalRegistrar } from "../web/ipc/localRegistrar.ts";
import { windowContract } from "@shigomori/contracts/modules/window";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import type { KeyValueStorage } from "../web/lib/kvStorage.ts";
import { defaultWebDeviceName } from "../web/account/deviceName.ts";
import { NO_STRUCTURAL_STUB, stubValueFor } from "../web/ipc/stubDefaults.ts";
import {
  delay,
  fakeSessionJwt,
  memoryStorage,
  waitFor,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

// ---- shims and fixtures ----

const HUB_URL = "https://hub.example.test";
const PUBLISHABLE_KEY = "pk_test_check";
const CONFIGURED_ENV = {
  SM_DEVICE_HUB_URL: HUB_URL,
  SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
};
const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function makeDeps(overrides: Partial<WebBridgeDeps> = {}): WebBridgeDeps {
  const localStorage = overrides.localStorage ?? memoryStorage();
  return {
    localStorage,
    deviceId: overrides.deviceId ?? getWebDeviceId(localStorage),
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

const jsonResponse = (status: number, body: unknown) =>
  Response.json(body, { status });

// The JSON document stored under `key`, which must be present.
const storedJson = (storage: KeyValueStorage, key: string) => {
  const raw = storage.getItem(key);
  assert(raw !== null, `nothing stored under ${key}`);
  return JSON.parse(raw);
};

const STORED_ENVELOPE = JSON.stringify({
  v: 1,
  enc: false,
  credential: "cred-stored",
  deviceKey: "device-key",
  accountId: "acct_stored",
  deviceName: "Stored browser",
});

it("surface: the bridge's page api has exactly every contract module by name plus peerApi, run, listen, pushes, view, deviceId, appVersion, clerkPublishableKey, isDev and isElectron", () => {
  const bridge = createWebBridge(makeDeps());
  assert.deepEqual(
    Object.keys(bridge.api).toSorted(),
    [
      ...allContractModules.map(nameOf),
      "peerApi",
      "run",
      "listen",
      "pushes",
      "view",
      "deviceId",
      "appVersion",
      "clerkPublishableKey",
      "isDev",
      "isElectron",
    ].toSorted(),
    "the bridge's top-level keys drifted from the preload surface",
  );
  assert.equal(typeof bridge.api.deviceId, "string");
  assert.equal(typeof bridge.api.appVersion, "string");
  // The Clerk mount decision, resolved from the baked env exactly
  // like the desktop preload resolves it from argv.
  assert.equal(bridge.api.clerkPublishableKey, PUBLISHABLE_KEY);
  assert.equal(typeof bridge.api.isDev, "boolean");
  // The app-only gate must read false here, or shared pages would
  // mount port-forward controls the browser cannot honor.
  assert.equal(bridge.api.isElectron, false);
});

it("deviceId: stable over the same storage, schema-valid, and distinct per browser profile", async () => {
  const localStorage = memoryStorage();
  const first = await establishWebDeviceId(localStorage, sharedLocks());
  assert.equal(await establishWebDeviceId(localStorage, sharedLocks()), first);
  assert.ok(Schema.is(DeviceIdSchema)(first));
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "the minted deviceId is not a well-formed UUID",
  );
  assert.notEqual(
    await establishWebDeviceId(memoryStorage(), sharedLocks()),
    first,
  );
  // A mangled stored id is replaced rather than trusted.
  localStorage.setItem("sm.web.deviceId", "not-a-uuid");
  const healed = await establishWebDeviceId(localStorage, sharedLocks());
  assert.notEqual(healed, "not-a-uuid");
  assert.ok(Schema.is(DeviceIdSchema)(healed));
  // The bridge carries the id it is given.
  const bridge = createWebBridge(makeDeps({ localStorage, deviceId: healed }));
  assert.equal(bridge.api.deviceId, healed);
});

it("clientConfig: reads default to {}, patches round-trip through localStorage, and corrupt JSON heals to defaults", async () => {
  const localStorage = memoryStorage();
  const bridge = createWebBridge(makeDeps({ localStorage }));
  assert.deepEqual(await bridge.api.run(bridge.api.clientConfig.read()), {});
  await bridge.api.run(
    bridge.api.clientConfig.patch({
      set: { theme: "dark", doubutsu: false },
      clear: [],
    }),
  );
  assert.deepEqual(await bridge.api.run(bridge.api.clientConfig.read()), {
    theme: "dark",
    doubutsu: false,
  });
  assert.deepEqual(
    storedJson(localStorage, "sm.web.clientConfig"),
    { theme: "dark", doubutsu: false },
    "the persisted document drifted from the written config",
  );
  localStorage.setItem("sm.web.clientConfig", "{corrupt");
  assert.deepEqual(await bridge.api.run(bridge.api.clientConfig.read()), {});
});

it("clientConfig: a patch keeps what another tab wrote, and the watch follows this tab's patches and another tab's writes", async () => {
  const localStorage = memoryStorage();
  const bridge = createWebBridge(makeDeps({ localStorage }));
  const seen: unknown[] = [];
  const stop = bridge.api.listen(
    bridge.api.view(clientConfigContract, "watch", undefined),
    (config) => seen.push(config),
  );
  trackTest(stop);
  await waitFor(() => seen.length === 1, "the watch's first value");
  assert.deepEqual(seen[0], {});
  // Another tab picks a theme, and this one hears of it.
  localStorage.setItem(
    "sm.web.clientConfig",
    JSON.stringify({ theme: "dark" }),
  );
  bridge.notifyClientConfigChanged();
  await waitFor(() => seen.length === 2, "another tab's write");
  assert.deepEqual(seen[1], { theme: "dark" });
  // This tab's patch, made off a copy that never saw the theme, keeps it.
  await bridge.api.run(
    bridge.api.clientConfig.patch({ set: { villageLife: true }, clear: [] }),
  );
  await waitFor(() => seen.length === 3, "this tab's patch");
  assert.deepEqual(seen[2], { theme: "dark", villageLife: true });
  await bridge.api.run(
    bridge.api.clientConfig.patch({ set: {}, clear: ["theme"] }),
  );
  await waitFor(() => seen.length === 4, "a cleared key");
  assert.deepEqual(seen[3], { villageLife: true });
});

it("clientConfig: the tab turns an Each launch rotation once, however often it is asked", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem(
    "sm.web.clientConfig",
    JSON.stringify({ themeRotation: "launch" }),
  );
  const bridge = createWebBridge(makeDeps({ localStorage }));
  const rotate = (launching: boolean) =>
    bridge.api.run(bridge.api.clientConfig.rotate({ launching }));
  const stamp = await rotate(true);
  assert.equal(typeof stamp, "number");
  const turned = await bridge.api.run(bridge.api.clientConfig.read());
  assert.equal(turned.themeRotatedAt, stamp);
  assert.equal(turned.lightTheme, "latte");
  assert.equal(await rotate(true), null, "a second window's launch");
  assert.equal(await rotate(false), null, "a minute's check");
  assert.deepEqual(
    await bridge.api.run(bridge.api.clientConfig.read()),
    turned,
  );
});

it("stubs: read-classified channels answer structural defaults, the previewTheme allowlist entry resolves, and stub subscriptions unsubscribe cleanly", async () => {
  const bridge = createWebBridge(makeDeps());
  // mutating:false reads stub to structural emptiness.
  assert.deepEqual(await bridge.api.run(bridge.api.projects.list()), []);
  assert.deepEqual(
    await bridge.api.run(bridge.api.worktrees.list({ projectId: "p1" })),
    [],
  );
  // Real handler, not a stub, but the same closed answer.
  assert.equal(
    await bridge.api.run(bridge.api.account.acceptsCommands()),
    false,
  );
  // The one allowlisted channel: ThemeProvider fires it per theme
  // change and a browser has no native chrome to sync.
  assert.equal(
    await bridge.api.run(bridge.api.window.previewTheme({ theme: "dark" })),
    undefined,
  );
  const stop = bridge.api.listen(
    bridge.api.pushes(gitContract, "refsRefreshed"),
    () => {},
  );
  assert.equal(typeof stop, "function");
  stop();
  // The walker itself: optional fields are left out, required ones
  // built, and an arm or a bounded string is only fabricated when
  // allowed.
  assert.equal(
    stubValueFor(Schema.NonEmptyString, { fabricateArms: false }),
    NO_STRUCTURAL_STUB,
  );
  const effectUnion = Schema.Union([
    Schema.Struct({ t: Schema.Literal("a"), n: Schema.Int }),
    Schema.Struct({ t: Schema.Literal("b") }),
  ]);
  assert.equal(
    stubValueFor(effectUnion, { fabricateArms: false }),
    NO_STRUCTURAL_STUB,
  );
  assert.equal(
    Schema.is(effectUnion)(stubValueFor(effectUnion, { fabricateArms: true })),
    true,
  );
  assert.deepEqual(
    stubValueFor(
      Schema.Struct({
        name: Schema.String,
        note: Schema.optional(Schema.NonEmptyString),
      }),
      { fabricateArms: false },
    ),
    { name: "" },
  );
  const { strict } = await import("@shigomori/contracts/schemas/strict");
  assert.deepEqual(
    stubValueFor(strict(Schema.Struct({ name: Schema.String })), {
      fabricateArms: false,
    }),
    { name: "" },
  );
  assert.equal(
    stubValueFor(
      Schema.Struct({ state: Schema.Literals(["granted", "denied"]) }),
      { fabricateArms: false },
    ),
    NO_STRUCTURAL_STUB,
  );
});

it("fail-closed: mutation-shaped and unclassified channels reject on the web instead of reporting stub success", async () => {
  const bridge = createWebBridge(makeDeps());
  const refused = /not available in the browser/;
  // The review's live findings: each of these previously resolved a
  // success-shaped stub ({ok:true}, a blank Worktree, undefined, a
  // blank project, a blank runId).
  await assert.rejects(
    bridge.api.run(
      bridge.api.worktrees.delete({ projectId: "p", worktreeId: "w" }),
    ),
    refused,
  );
  await assert.rejects(
    bridge.api.run(
      bridge.api.worktrees.push({ projectId: "p", worktreeId: "w" }),
    ),
    refused,
  );
  await assert.rejects(bridge.api.run(bridge.api.runtime.nuke()), refused);
  await assert.rejects(
    bridge.api.run(bridge.api.projects.add({ path: "/tmp/x" })),
    refused,
  );
  await assert.rejects(
    bridge.api.run(
      bridge.api.scripts.run({
        projectId: "p",
        worktreeId: "w",
        script: "setup",
      }),
    ),
    refused,
  );
  // A read gated on the command-access switch is classified mutating, so
  // it rejects too, which also covers the affirmative-biased enum
  // its output would otherwise stub to (cli.status's first arm is
  // "installed").
  await assert.rejects(bridge.api.run(bridge.api.cli.status()), refused);
  // updater:get IS a classified read (a peer's Settings tab shows
  // that device's update state), but its output is a discriminated
  // union, so the structural stubber refuses it rather than
  // fabricate an "idle" that would claim the browser is up to date.
  // The commands refuse like every other mutation.
  await assert.rejects(
    bridge.api.run(bridge.api.updater.get()),
    /has no safe empty answer in the browser/,
  );
  await assert.rejects(bridge.api.run(bridge.api.updater.check()), refused);
  await assert.rejects(bridge.api.run(bridge.api.updater.install()), refused);
  await assert.rejects(bridge.api.run(bridge.api.updater.update()), refused);
  // The villager data is local only (the desktop's own device), so
  // a tab refuses every call: it has no device to hold it.
  await Promise.all(
    [
      bridge.api.run(bridge.api.villagers.status()),
      bridge.api.run(bridge.api.villagers.download()),
      bridge.api.run(bridge.api.villagers.cancel()),
      bridge.api.run(bridge.api.villagers.remove()),
      bridge.api.run(bridge.api.villagers.face({ slug: "ace" })),
      bridge.api.run(bridge.api.villagers.profiles()),
    ].map((call) => assert.rejects(call, /is not available in the browser/)),
  );
  // The port-forward engine binds real TCP listeners, so its whole
  // client-scoped surface must refuse on the web (the UI never
  // mounts there, gated on isElectron, but the wire is the wall).
  await assert.rejects(bridge.api.run(bridge.api.portForward.list()), refused);
  await assert.rejects(
    bridge.api.run(
      bridge.api.portForward.start({ deviceId: "d1", remotePort: 3000 }),
    ),
    refused,
  );
  // These are mutating-rejects (remote:true, mutating:true), and
  // the tab's registrar must refuse them: the fs reads because they
  // are gated on the command-access switch, the preference/registry
  // writes and the device-settings write because they are commands.
  await assert.rejects(
    bridge.api.run(bridge.api.fs.listDirectory({ path: "/tmp" })),
    refused,
  );
  await assert.rejects(
    bridge.api.run(bridge.api.fs.scanForGitRepos({ path: "/tmp" })),
    refused,
  );
  await assert.rejects(
    bridge.api.run(bridge.api.fs.isGitRepo({ path: "/tmp" })),
    refused,
  );
  await assert.rejects(
    bridge.api.run(bridge.api.projects.remove({ id: "p1" })),
    refused,
  );
  await assert.rejects(
    bridge.api.run(
      bridge.api.packageScripts.setSort({
        projectId: "p1",
        mode: "alphabetical",
      }),
    ),
    refused,
  );
  await assert.rejects(
    bridge.api.run(
      bridge.api.globalConfig.writeDeviceSettings({
        patch: { githubCli: false },
      }),
    ),
    refused,
  );
  // Peers' command access is reported only from what their dials
  // answered, so with no session there is none to report. A web
  // registrar must never manufacture a verdict.
  assert.deepEqual(
    (await bridge.api.run(bridge.api.hub.status())).peerAcceptsCommands,
    {},
  );
  // The real refuse-all handler names its refusal precisely.
  await assert.rejects(
    bridge.api.run(bridge.api.account.setAcceptsCommands(true)),
    /cannot change command access/,
  );
});

it("shell: openExternal reaches the injected opener and showItemInFolder is a harmless no-op", async () => {
  const opened: string[] = [];
  const bridge = createWebBridge(
    makeDeps({ openExternal: (url) => opened.push(url) }),
  );
  trackTest(() => bridge.stop());
  await bridge.api.run(
    bridge.api.shell.openExternal({ url: "https://example.com/page" }),
  );
  assert.deepEqual(opened, ["https://example.com/page"]);
  assert.equal(
    await bridge.api.run(
      bridge.api.shell.showItemInFolder({ path: "/somewhere" }),
    ),
    undefined,
  );
});

it("shell: what the opener throws reaches the caller as it is", async () => {
  const failure = new TypeError("opener unavailable");
  const bridge = createWebBridge(
    makeDeps({
      openExternal: () => {
        throw failure;
      },
    }),
  );
  trackTest(() => bridge.stop());
  await assert.rejects(
    bridge.api.run(
      bridge.api.shell.openExternal({ url: "https://example.com/page" }),
    ),
    (error: unknown) => error === failure,
  );
});

it("in the page, a dev build checks each answer against its output schema, and a packaged one hands it through", async () => {
  const malformed = { port: "not a port", token: 1, deviceId: null };
  const answer = (validateOutputs: boolean) => {
    const tab = createLocalRegistrar({ validateOutputs });
    // The malformed answer is the point.
    tab.served.serveOne(
      windowContract,
      "hostAddress",
      () => malformed as never,
    );
    return Effect.runPromise(tab.link.call("window:hostAddress", undefined));
  };
  await assert.rejects(answer(true));
  assert.deepEqual(await answer(false), malformed);
});

it('enroll: exchanges the Clerk session token for a credential with platform "web" under this deviceId, and persists the enc:false envelope', async () => {
  const localStorage = memoryStorage();
  const requests = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === `${HUB_URL}/devices/enroll`) {
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      assert.equal(body.platform, "web");
      assert.equal(body.icon, "browser");
      assert.equal(body.deviceId, deviceId);
      assert.equal(body.name, defaultWebDeviceName(CHROME_MAC_UA));
      // The enroll bearer is the session token itself, never a
      // derived or stored value.
      assert.equal(
        new Headers(init.headers).get("authorization"),
        `Bearer ${fakeSessionJwt("acct_1")}`,
      );
      return jsonResponse(200, {
        credential: "cred-1",
        device: {
          deviceId: body.deviceId,
          name: body.name,
          platform: body.platform,
          icon: body.icon,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    if (url === `${HUB_URL}/tickets`) {
      // The post-enroll hub refresh mints here, and failing it
      // plainly parks the supervisor in backoff until the tracked
      // stop.
      return jsonResponse(500, { error: "no device hub in this check" });
    }
    throw new Error(`unexpected fetch in enroll check: ${url}`);
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  const deviceId = bridge.api.deviceId;

  const status = await bridge.api.run(
    bridge.api.account.enroll(fakeSessionJwt("acct_1")),
  );
  assert.equal(status.signedIn, true);
  assert.equal(status.accountId, "acct_1");

  const envelope = storedJson(localStorage, "sm.web.account");
  assert.deepEqual(envelope, {
    v: 1,
    enc: false,
    credential: "cred-1",
    deviceKey: envelope.deviceKey,
    accountId: "acct_1",
    deviceName: defaultWebDeviceName(CHROME_MAC_UA),
    hubName: defaultWebDeviceName(CHROME_MAC_UA),
    hubIcon: "browser",
  });
  // Auth state survives a "reload": a fresh bridge over the same
  // storage reads the same signed-in status.
  const reloaded = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  const after = await reloaded.api.run(reloaded.api.account.status());
  assert.equal(after.signedIn, true);
  assert.equal(after.accountId, "acct_1");
});

it("account change: a sign-in from signed out keeps the picks made signed out, and a sign-out drops them once the old account's hub socket stopped", async () => {
  const localStorage = memoryStorage();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${HUB_URL}/devices/enroll`) {
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      return jsonResponse(200, {
        credential: "cred-1",
        device: {
          ...body,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    // The hub refresh's ticket mint, which parks the supervisor.
    return jsonResponse(500, { error: "no device hub in this check" });
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  const picks = async () => ({
    collapsed: (await bridge.api.run(bridge.api.clientConfig.read()))
      .collapsedProjects,
    shared: (await bridge.api.run(bridge.api.sharedSettings.read())).entries[
      "pinnedProject/p1"
    ]?.value,
  });
  await bridge.api.run(
    bridge.api.clientConfig.patch({
      set: { collapsedProjects: ["p1"] },
      clear: [],
    }),
  );
  await bridge.api.run(
    bridge.api.sharedSettings.set({ key: "pinnedProject/p1", value: "1" }),
  );
  await bridge.api.run(bridge.api.account.enroll(fakeSessionJwt("acct_1")));
  assert.deepEqual(
    await picks(),
    { collapsed: ["p1"], shared: "1" },
    "a sign-in from signed out dropped the picks made signed out",
  );
  // A peer's push landing between the clear and the old sessions'
  // close would refill the copy: the socket stops first.
  const order: string[] = [];
  const stops = [
    bridge.api.listen(
      bridge.api.pushes(hubContract, "statusChanged"),
      (status) => void order.push(`hub ${status.socket.phase}`),
    ),
    bridge.api.listen(
      bridge.api.pushes(sharedSettingsContract, "changed"),
      () => void order.push("cleared"),
    ),
  ];
  trackTest(() => {
    for (const stop of stops) stop();
  });
  await bridge.api.run(bridge.api.account.signOut());
  assert.deepEqual(await picks(), { collapsed: undefined, shared: undefined });
  await waitFor(() => order.includes("cleared"), "the copy's clear");
  assert.ok(
    order.indexOf("hub stopped") !== -1 &&
      order.indexOf("hub stopped") < order.indexOf("cleared"),
    `cleared before the hub socket stopped: ${order.join(", ")}`,
  );
});

it("sign-out: revokes THIS device on the device hub, clears the envelope, and still signs out when the revoke fails", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem("sm.web.account", STORED_ENVELOPE);
  const deletes: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "DELETE") {
      deletes.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch in sign-out check: ${url}`);
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  await bridge.api.run(bridge.api.account.signOut());
  assert.equal(deletes.length, 1);
  assert.equal(
    deletes[0]?.url,
    `${HUB_URL}/devices/${encodeURIComponent(bridge.api.deviceId)}`,
  );
  assert.equal(deletes[0]?.auth, "Bearer cred-stored");
  // Signed out: the envelope keeps the name and nothing else.
  assert.deepEqual(storedJson(localStorage, "sm.web.account"), {
    v: 1,
    signedOut: true,
    deviceName: "Stored browser",
  });
  assert.equal(
    (await bridge.api.run(bridge.api.account.status())).signedIn,
    false,
  );

  // The failure path: revoke rejects, local sign-out still lands.
  const second = memoryStorage();
  second.setItem("sm.web.account", STORED_ENVELOPE);
  const failing = createWebBridge(
    makeDeps({
      localStorage: second,
      fetchImpl: () => Promise.reject(new TypeError("offline")),
    }),
  );
  trackTest(() => failing.stop());
  await failing.api.run(failing.api.account.signOut());
  assert.equal(
    (await failing.api.run(failing.api.account.status())).signedIn,
    false,
  );
  // The undelivered revoke is parked with its credential, for the
  // next boot's retry (a bridge over the same storage), which
  // delivers it and clears the parking.
  const parked = storedJson(second, "sm.web.account");
  assert.equal(parked.signedOut, true);
  assert.equal(parked.parked.credential, "cred-stored");
  const retryDeletes: string[] = [];
  const retried = createWebBridge(
    makeDeps({
      localStorage: second,
      fetchImpl: async (input, init) => {
        if (init?.method === "DELETE") retryDeletes.push(String(input));
        return new Response(null, { status: 204 });
      },
    }),
  );
  trackTest(() => retried.stop());
  await waitFor(
    () => retryDeletes.length === 1,
    "the parked revoke to be delivered at boot",
  );
  await waitFor(
    () => storedJson(second, "sm.web.account").parked === undefined,
    "the parking to clear",
  );
});

it("enroll and sign-out: a caller arriving while one runs rides it, a failed run is not kept, and the first after one settles starts afresh", async () => {
  const localStorage = memoryStorage();
  // Each enroll's bearer, and each revoke, held until released.
  const enrolls: (string | null)[] = [];
  let revokes = 0;
  let release: (() => void) | undefined;
  let refuse = false;
  const held = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${HUB_URL}/devices/enroll`) {
      enrolls.push(new Headers(init.headers).get("authorization"));
      await held();
      if (refuse) return jsonResponse(403, { error: "refused" });
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      return jsonResponse(200, {
        credential: `cred-${enrolls.length}`,
        device: {
          deviceId: body.deviceId,
          name: body.name,
          platform: body.platform,
          icon: body.icon,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    if (init.method === "DELETE") {
      revokes += 1;
      await held();
      return new Response(null, { status: 204 });
    }
    if (url === `${HUB_URL}/tickets`) {
      return jsonResponse(500, { error: "no device hub in this check" });
    }
    throw new Error(`unexpected fetch in single-flight check: ${url}`);
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  const { account, run } = bridge.api;

  // Two at once are one enroll, under the first caller's token.
  const first = run(account.enroll(fakeSessionJwt("acct_1")));
  const second = run(account.enroll(fakeSessionJwt("acct_2")));
  await waitFor(
    () => enrolls.length === 1,
    "the first enroll to reach the hub",
  );
  release?.();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.deepEqual(enrolls, [`Bearer ${fakeSessionJwt("acct_1")}`]);
  assert.equal(firstStatus.accountId, "acct_1");
  assert.deepEqual(secondStatus, firstStatus);

  // A refused run fails everyone riding it, and is not kept.
  refuse = true;
  const refused = [
    run(account.enroll(fakeSessionJwt("acct_1"))),
    run(account.enroll(fakeSessionJwt("acct_1"))),
  ];
  await waitFor(
    () => enrolls.length === 2,
    "the refused enroll to reach the hub",
  );
  release?.();
  const settled = await Promise.allSettled(refused);
  assert.deepEqual(
    settled.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(enrolls.length, 2, "the refused run was shared");
  refuse = false;
  const afresh = run(account.enroll(fakeSessionJwt("acct_1")));
  await waitFor(() => enrolls.length === 3, "a fresh enroll after the refusal");
  release?.();
  assert.equal((await afresh).signedIn, true);

  // Two sign-outs at once are one revoke.
  const signOuts = [run(account.signOut()), run(account.signOut())];
  await waitFor(() => revokes === 1, "the sign-out's revoke to reach the hub");
  release?.();
  await Promise.all(signOuts);
  assert.equal(revokes, 1);
  assert.equal((await run(account.status())).signedIn, false);
});

it("unconfigured: status reports configured false, enroll rejects, and the hub refresh leaves the socket stopped", async () => {
  const bridge = createWebBridge(makeDeps({ env: {} }));
  trackTest(() => bridge.stop());
  const status = await bridge.api.run(bridge.api.account.status());
  assert.equal(status.configured, false);
  assert.equal(bridge.api.clerkPublishableKey, "");
  await assert.rejects(
    bridge.api.run(bridge.api.account.enroll(fakeSessionJwt("acct_1"))),
    /not configured/,
  );
  await bridge.refreshHub();
  const hub = await bridge.api.run(bridge.api.hub.status());
  assert.notEqual(hub.socket.phase, "connecting");
  assert.notEqual(hub.socket.phase, "backoff");
  assert.deepEqual(hub.onlineDeviceIds, []);
});

it("refused: a hub 401 on the ticket mint (a credential it no longer honors) blocks the supervisor after one mint with the hub's message, no retry loop", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem("sm.web.account", STORED_ENVELOPE);
  let mints = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${HUB_URL}/tickets`) {
      mints += 1;
      return jsonResponse(401, { _tag: "HubCredentialRejectedError" });
    }
    throw new Error(`unexpected fetch in blocked check: ${url}`);
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  await bridge.refreshHub();
  const socket = async () =>
    (await bridge.api.run(bridge.api.hub.status())).socket;
  await waitFor(
    async () => (await socket()).phase === "blocked",
    "the blocked socket phase",
  );
  const blocked = await socket();
  assert(blocked.phase === "blocked");
  assert.match(blocked.message, /no longer accepts this device's credential/);
  // Longer than the supervisor's first backoff rung: a retry loop
  // would have minted again by now.
  await delay(1_300);
  assert.equal(mints, 1, "the blocked deployment was redialed");
  const settled = await socket();
  assert.equal(settled.phase, "blocked");
  assert.equal(settled.reason, "refused");
});

it("revoked: the hub's typed revoked refusal on the mint blocks as REVOKED, the verdict the app signs out on, exactly as the socket close would have", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem("sm.web.account", STORED_ENVELOPE);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${HUB_URL}/tickets`) {
      return jsonResponse(403, { _tag: "HubDeviceRevokedError" });
    }
    throw new Error(`unexpected fetch in revoked check: ${url}`);
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  await bridge.refreshHub();
  const socket = async () =>
    (await bridge.api.run(bridge.api.hub.status())).socket;
  await waitFor(
    async () => (await socket()).phase === "blocked",
    "the blocked socket phase",
  );
  const revoked = await socket();
  assert(revoked.phase === "blocked");
  assert.equal(revoked.reason, "revoked");
});

it("update required: the hub's version floor on the mint blocks as update-required in the hub's words, never as a sign-out", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem("sm.web.account", STORED_ENVELOPE);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === `${HUB_URL}/tickets`) {
      return jsonResponse(403, {
        _tag: "HubUpdateRequiredError",
        floor: 99,
        error: "Update it to connect.",
      });
    }
    throw new Error(`unexpected fetch in update check: ${url}`);
  };
  const bridge = createWebBridge(makeDeps({ localStorage, fetchImpl }));
  trackTest(() => bridge.stop());
  await bridge.refreshHub();
  const socket = async () =>
    (await bridge.api.run(bridge.api.hub.status())).socket;
  await waitFor(
    async () => (await socket()).phase === "blocked",
    "the blocked socket phase",
  );
  const blocked = await socket();
  assert(blocked.phase === "blocked");
  assert.equal(blocked.reason, "update-required");
  assert.equal(blocked.message, "Update it to connect.");
});

it("device names: the user-agent default is short and human-readable across the major browsers", () => {
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
    "Safari on iPhone",
  );
  assert.equal(
    defaultWebDeviceName(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    "Safari on iPad",
  );
  assert.equal(defaultWebDeviceName("weird/0.0"), "Browser");
});

it("device names: client hints name the Chromium forks whose user agent says Chrome, and say nothing extra when they only repeat it", () => {
  // Edge and Brave over a Chrome user agent: the brand entry (or
  // the navigator.brave object) is the only thing that tells.
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: ["Not A;Brand", "Chromium", "Microsoft Edge"],
    }),
    "Edge on macOS",
  );
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: ["Chromium", "Not/A)Brand", "Brave"],
    }),
    "Brave on macOS",
  );
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: ["Chromium", "Google Chrome", "Not?A_Brand"],
      brave: true,
    }),
    "Brave on macOS",
  );
  // Chrome itself, and a fork that only names Chromium: both fall
  // through to what the user agent already says.
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: ["Google Chrome", "Chromium", "Not.A/Brand"],
    }),
    "Chrome on macOS",
  );
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: ["Chromium", "Not_A Brand"],
    }),
    "Chrome on macOS",
  );
  // A fork the table does not know passes through as it spelled
  // itself, and a browser with no hints at all is the plain case.
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: ["Not A;Brand", "Chromium", "Opera"],
    }),
    "Opera on macOS",
  );
  assert.equal(
    defaultWebDeviceName(CHROME_MAC_UA, {
      brands: undefined,
      brave: false,
    }),
    "Chrome on macOS",
  );
});

// A lock manager as the profile's tabs share one: each name's callbacks
// run one after another.
function sharedLocks(): Pick<LockManager, "request"> {
  const tails = new Map<string, Promise<unknown>>();
  return {
    // As the tab asks: a name, its options, the callback.
    request: ((
      name: string,
      _options: { signal?: AbortSignal },
      callback: () => Promise<unknown>,
    ) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    }) as Pick<LockManager, "request">["request"],
  };
}

it("two tabs enrolling at once: one enrolls, and the profile keeps the credential the hub holds", async () => {
  const localStorage = memoryStorage();
  const locks = sharedLocks();
  let minted = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input) === `${HUB_URL}/devices/enroll`) {
      minted += 1;
      const credential = `cred-${minted}`;
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      // The first enroll answers last, so the two would land out of
      // order, unlocked.
      if (minted === 1) await new Promise((done) => setTimeout(done, 200));
      return jsonResponse(200, {
        credential,
        device: {
          ...body,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    return jsonResponse(500, { error: "no device hub in this check" });
  };
  const tabs = [0, 1].map(() => {
    const bridge = createWebBridge(
      makeDeps({ localStorage, fetchImpl, locks }),
    );
    trackTest(() => bridge.stop());
    return bridge;
  });
  await Promise.all(
    tabs.map((tab) =>
      tab.api.run(tab.api.account.enroll(fakeSessionJwt("acct_1"))),
    ),
  );
  assert.equal(minted, 1, "both tabs enrolled");
  assert.equal(
    storedJson(localStorage, "sm.web.account").credential,
    `cred-${minted}`,
  );
});

type WebBridgeOf = ReturnType<typeof createWebBridge>;

it("a sign-out in one tab while another tab's enrollment waits on the hub takes its turn after it, so the profile ends signed out", async () => {
  const localStorage = memoryStorage();
  const locks = sharedLocks();
  const held: { release?: () => void } = {};
  const answered = new Promise<void>((resolve) => {
    held.release = resolve;
  });
  const release = () => held.release?.();
  let enrolls = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input) === `${HUB_URL}/devices/enroll`) {
      enrolls += 1;
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      await answered;
      return jsonResponse(200, {
        credential: "cred-1",
        device: {
          ...body,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return jsonResponse(500, { error: "no device hub in this check" });
  };
  const [enrolling, leaving] = [0, 1].map(() => {
    const bridge = createWebBridge(
      makeDeps({ localStorage, fetchImpl, locks }),
    );
    trackTest(() => bridge.stop());
    return bridge;
  }) as [WebBridgeOf, WebBridgeOf];
  const enrolled = enrolling.api.run(
    enrolling.api.account.enroll(fakeSessionJwt("acct_1")),
  );
  await waitFor(() => enrolls === 1, "the enrollment to reach the hub");
  const signedOut = leaving.api.run(leaving.api.account.signOut());
  release();
  await enrolled;
  await signedOut;
  assert.equal(
    storedJson(localStorage, "sm.web.account").credential,
    undefined,
    "the other tab's enrollment signed the profile back in",
  );
});

it("shared settings another tab wrote reach this tab's watch", async () => {
  const localStorage = memoryStorage();
  const tab = () => {
    const bridge = createWebBridge(makeDeps({ localStorage }));
    trackTest(() => bridge.stop());
    return bridge;
  };
  const here = tab();
  const there = tab();
  const seen: unknown[] = [];
  const stop = here.api.listen(
    here.api.view(sharedSettingsContract, "watch", undefined),
    (doc) => seen.push(doc),
  );
  trackTest(stop);
  await there.api.run(
    there.api.sharedSettings.set({ key: "pinnedProject/p1", value: true }),
  );
  // The storage event, which only the other tabs hear.
  here.notifySharedSettingsChanged();
  await waitFor(
    () =>
      seen.some(
        (doc) =>
          (doc as { entries: Record<string, { value: unknown }> }).entries[
            "pinnedProject/p1"
          ]?.value === true,
      ),
    "the other tab's pick in this tab's watch",
  );
});

it("two fresh tabs at once: the device id is minted under the account lock, so both tabs and the credential the profile keeps name one device", async () => {
  const backing = memoryStorage();
  const shared = sharedLocks();
  let held = 0;
  const locks: Pick<LockManager, "request"> = {
    request: ((
      name: string,
      options: { signal?: AbortSignal },
      callback: () => Promise<unknown>,
    ) =>
      shared.request(name, options, async () => {
        held += 1;
        try {
          return await callback();
        } finally {
          held -= 1;
        }
      })) as Pick<LockManager, "request">["request"],
  };
  // Whether the account lock was held at each write of the id.
  const writes: boolean[] = [];
  const localStorage: KeyValueStorage = {
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => {
      if (key === "sm.web.deviceId") writes.push(held > 0);
      backing.setItem(key, value);
    },
    removeItem: (key) => backing.removeItem(key),
  };
  const enrolled: string[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input) === `${HUB_URL}/devices/enroll`) {
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      enrolled.push(body.deviceId);
      return jsonResponse(200, {
        credential: "cred-1",
        device: {
          ...body,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    return jsonResponse(500, { error: "no device hub in this check" });
  };
  const ids = await Promise.all(
    [0, 1].map(() => establishWebDeviceId(localStorage, locks)),
  );
  assert.deepEqual(writes, [true], "minted unlocked, or twice");
  const tabs = ids.map((deviceId) => {
    const bridge = createWebBridge(
      makeDeps({ localStorage, deviceId, fetchImpl, locks }),
    );
    trackTest(() => bridge.stop());
    return bridge;
  });
  await Promise.all(
    tabs.map((tab) =>
      tab.api.run(tab.api.account.enroll(fakeSessionJwt("acct_1"))),
    ),
  );
  const [stored] = ids;
  assert.deepEqual(
    tabs.map((tab) => tab.api.deviceId),
    [stored, stored],
  );
  assert.equal(backing.getItem("sm.web.deviceId"), stored);
  assert.deepEqual(enrolled, [stored]);
});

it("deviceId: a stored id boots without the account lock, and a tab that waits the lock out mints its own", async () => {
  const localStorage = memoryStorage();
  const timedOut: Pick<LockManager, "request"> = {
    request: (() =>
      Promise.reject(
        new DOMException("The lock wait timed out.", "TimeoutError"),
      )) as Pick<LockManager, "request">["request"],
  };
  const minted = await establishWebDeviceId(localStorage, timedOut);
  assert.equal(localStorage.getItem("sm.web.deviceId"), minted);
  const unasked: Pick<LockManager, "request"> = {
    request: (() => {
      throw new Error("the lock was asked for a stored id");
    }) as Pick<LockManager, "request">["request"],
  };
  assert.equal(await establishWebDeviceId(localStorage, unasked), minted);
});

// The profile's storage refusing the account document's writes, as a
// full quota or a privacy mode does, and with `removals` its removal.
const refuseAccount = (key: string) => {
  if (key === "sm.web.account") {
    throw new DOMException(
      "The quota has been exceeded.",
      "QuotaExceededError",
    );
  }
};
function refusingAccountWrites(
  backing: KeyValueStorage,
  removals = false,
): KeyValueStorage {
  return {
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => {
      refuseAccount(key);
      backing.setItem(key, value);
    },
    removeItem: (key) => {
      if (removals) refuseAccount(key);
      backing.removeItem(key);
    },
  };
}

it("sign-out where storage refuses the signed-out remainder: the document goes instead, so this tab and the profile's other tab read signed out, with the revoke delivered or not", async () => {
  for (const revoke of ["delivered", "offline"] as const) {
    const backing = memoryStorage();
    backing.setItem("sm.web.account", STORED_ENVELOPE);
    const localStorage = refusingAccountWrites(backing);
    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      if (revoke === "offline") throw new TypeError("offline");
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse(500, { error: "no device hub in this check" });
    };
    const locks = sharedLocks();
    const open = () => {
      const bridge = createWebBridge(
        makeDeps({ localStorage, fetchImpl, locks }),
      );
      trackTest(() => bridge.stop());
      return bridge;
    };
    const leaving = open();
    const other = open();
    await leaving.api.run(leaving.api.account.signOut());
    assert.equal(backing.getItem("sm.web.account"), null, `${revoke}: kept`);
    for (const tab of [leaving, other]) {
      const status = await tab.api.run(tab.api.account.status());
      assert.equal(status.signedIn, false, `${revoke}: a tab reads signed in`);
    }
  }
});

it("sign-out where storage refuses the document's removal too: the sign-out fails, and the tab still reads signed in", async () => {
  const backing = memoryStorage();
  backing.setItem("sm.web.account", STORED_ENVELOPE);
  const bridge = createWebBridge(
    makeDeps({
      localStorage: refusingAccountWrites(backing, true),
      fetchImpl: () => Promise.reject(new TypeError("offline")),
      locks: sharedLocks(),
    }),
  );
  trackTest(() => bridge.stop());
  await assert.rejects(bridge.api.run(bridge.api.account.signOut()));
  assert.equal(backing.getItem("sm.web.account"), STORED_ENVELOPE);
  const status = await bridge.api.run(bridge.api.account.status());
  assert.equal(status.signedIn, true);
});

it("enroll where storage refuses the credential: the enroll fails rather than report a sign-in it didn't keep", async () => {
  const backing = memoryStorage();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input) === `${HUB_URL}/devices/enroll`) {
      assert(init.body instanceof Uint8Array);
      const body = JSON.parse(new TextDecoder().decode(init.body));
      return jsonResponse(200, {
        credential: "cred-1",
        device: {
          ...body,
          createdAt: Date.now(),
          lastSeenAt: null,
          online: false,
        },
      });
    }
    return jsonResponse(500, { error: "no device hub in this check" });
  };
  const bridge = createWebBridge(
    makeDeps({
      localStorage: refusingAccountWrites(backing),
      fetchImpl,
      locks: sharedLocks(),
    }),
  );
  trackTest(() => bridge.stop());
  await assert.rejects(
    bridge.api.run(bridge.api.account.enroll(fakeSessionJwt("acct_1"))),
  );
  assert.equal(backing.getItem("sm.web.account"), null);
});
