// Durable proof for the web client's tabs (V3.md, "The web client's
// tabs"): a browser profile is one device, and each of its tabs is a
// connection of its own to a host. Two web bridges over the same
// storage (two tabs of one profile) against the stub device hub and a
// REAL direct listener: both link to the host, each calls it and hears
// its pushes, and neither link ends the other's. A tab reloading (its
// bridge gone, a new one over the same storage) leaves its sibling
// linked.
//
// The stub hub keys a web device's sockets by connection, as the
// Durable Object does: every tab keeps its hub socket, the hub relays to
// each, and a sibling's answers never settle a tab's own asks.
//
// Run: pnpm test web-tabs.
import assert from "node:assert/strict";
import { it } from "vitest";
import { makeConnectInfo } from "@host/direct/connectInfo";
import { createWebBridge, type WebBridge } from "../web/ipc/register.ts";
import { startDirectListener } from "./lib/directBoot.mts";
import { bootDevice } from "./lib/hubBoot.mts";
import { startStubHub, testDeviceKey } from "./lib/hubStub.mts";
import { memoryStorage, waitFor } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

// A read the listener serves, answering with what it was asked.
const ECHO = "projects:defaultBranch";
const PUSH = "git:projectChanged";

// The profile's key, which the stub hub names for any device but the
// host.
const PROFILE_KEY = testDeviceKey("profile");

const STORED_ENVELOPE = JSON.stringify({
  v: 1,
  enc: false,
  credential: "cred-stored",
  deviceKey: PROFILE_KEY.privateKey,
  accountId: "acct",
  deviceName: "Stored browser",
});

async function boot() {
  const track = trackTest;
  const stub = await startStubHub(track, (deviceId) =>
    deviceId === "A" ? testDeviceKey("A").publicKey : PROFILE_KEY.publicKey,
  );
  const listener = await startDirectListener(track, {
    deviceId: "A",
    registerHandlers: (binding) => {
      binding.handle(
        ECHO,
        async (_ctx, raw) => (raw as { projectId: string }).projectId,
      );
    },
  });
  // The host, answering connectInfo over the hub with its listener.
  await bootDevice(
    stub,
    "A",
    {
      serveConnectInfo: makeConnectInfo({
        listenerPort: listener.listenerPort,
        mintTickets: (peer, kinds) => listener.tickets.mint(peer, kinds),
        candidateAddresses: () => ["127.0.0.1"],
        tunnelUrl: () => null,
        acceptsCommands: () => false,
        sharesData: () => true,
      }),
    },
    track,
  );
  // One browser profile: the storage every tab of it shares, signed in.
  const storage = memoryStorage();
  storage.setItem("sm.web.account", STORED_ENVELOPE);
  let mints = 0;
  const tab = (): WebBridge => {
    const bridge = createWebBridge({
      localStorage: storage,
      env: {
        SM_DEVICE_HUB_URL: stub.hubUrl,
        SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: "pk_test_check",
      },
      userAgent: "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36",
      openExternal: () => {},
      isDev: true,
      appVersion: "1.0.0",
      dialableKinds: ["lan"],
      // The hub's ticket mint, in the stub hub's ticket form.
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "POST" && url.pathname === "/tickets") {
          mints += 1;
          const body = init.body instanceof Uint8Array ? init.body : undefined;
          const { connectionId } = JSON.parse(
            new TextDecoder().decode(body),
          ) as { connectionId: string };
          return Response.json({
            ticket: `t:${bridge.api.deviceId}:web:${connectionId}`,
            expiresInMs: 60_000,
          });
        }
        throw new TypeError(`fetch is not stubbed for ${url.pathname}`);
      },
    });
    track(() => bridge.stop());
    void bridge.refreshHub();
    return bridge;
  };
  return { listener, tab };
}

// The tab's call to the host, over its own link.
const echo = (tab: WebBridge, value: string) =>
  tab.api.hub.invokePeer({
    deviceId: "A",
    channel: ECHO,
    input: { projectId: value },
  });

const linked = (tab: WebBridge) =>
  waitFor(
    async () => (await tab.api.hub.status()).peerAppVersions.A !== undefined,
    "the tab to link to the host",
  );

it("two tabs of one profile each link to the host, call it and hear its pushes", async () => {
  const { listener, tab } = await boot();
  const first = tab();
  await linked(first);
  const second = tab();
  await linked(second);
  assert.equal(first.api.deviceId, second.api.deviceId);
  // Neither tab's hub socket ended the other's.
  for (const each of [first, second]) {
    // oxlint-disable-next-line no-await-in-loop -- two tabs, order does not matter
    assert.equal((await each.api.hub.status()).socket.phase, "connected");
  }
  assert.equal(await echo(first, "first"), "first");
  assert.equal(await echo(second, "second"), "second");
  const heard = { first: 0, second: 0 };
  first.api.hub.onPeerPush((push) => {
    if (push.channel === PUSH) heard.first += 1;
  });
  second.api.hub.onPeerPush((push) => {
    if (push.channel === PUSH) heard.second += 1;
  });
  await waitFor(() => {
    listener.binding.broadcastAll(PUSH, { projectId: "p" }, { remote: true });
    return heard.first > 0 && heard.second > 0;
  }, "both tabs to hear the host's push");
  // The first tab's link outlived the second's arrival.
  assert.equal(await echo(first, "still"), "still");
  assert.equal((await first.api.hub.status()).socket.phase, "connected");
});

it("a tab reloading leaves its sibling linked", async () => {
  const { tab } = await boot();
  const staying = tab();
  await linked(staying);
  const reloading = tab();
  await linked(reloading);
  await reloading.stop();
  const reloaded = tab();
  await linked(reloaded);
  assert.equal(await echo(reloaded, "back"), "back");
  assert.equal(await echo(staying, "stayed"), "stayed");
});
