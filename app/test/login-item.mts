// Proof for the login item (main/electron/liveness.ts, loginItemLayer):
// it is reconciled once as the shell's graph comes up, again when
// keepReachable changes and when the account's id does (a sign-in, a
// switch, a sign-out), and not on a client config write that leaves
// keepReachable as it was (a theme, a palette) or a rename of this
// device, which keeps the account (main/electron/account.ts).
//
// Run: pnpm test login-item.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterAll, it, vi } from "vitest";
import { waitFor } from "./lib/checkKit.mts";

const dir = mkdtempSync(join(tmpdir(), "login-item-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const loginItems: boolean[] = [];
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    isReady: () => true,
    getPath: () => dir,
    setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) =>
      loginItems.push(openAtLogin),
  },
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: {},
  BrowserWindow: {},
  powerMonitor: {},
}));
// A platform with login items, wherever the proof runs.
vi.mock("node:os", async (actual) => ({
  ...(await actual<typeof import("node:os")>()),
  platform: () => "darwin",
}));
vi.mock("../main/hostProcess", () => ({
  host: () => ({ account: () => Effect.void }),
  hostDeviceId: async () => "login-item-device",
}));
vi.mock("../main/ipc/register", () => ({ broadcastAll: () => {} }));
vi.mock("../main/core/account/defaultDeviceName", () => ({
  defaultDesktopDeviceName: async () => ({ name: "Mac", provisional: false }),
}));
vi.mock("../main/core/account/defaultDeviceIcon", () => ({
  detectDesktopDeviceShape: async () => "laptop",
}));

// What a packaged prod build has baked in, and an account service.
Object.assign(globalThis, {
  __SM_PACKAGED_FLAVOR__: "prod",
  __SM_ACCOUNT_BAKED_ENV__: {},
});
process.env.SM_DEVICE_HUB_URL = "http://127.0.0.1:1";
process.env.SM_ACCOUNT_CLERK_PUBLISHABLE_KEY = "pk_test_login_item";

const ClientConfig = await import("../main/electron/clientConfig");
const { desktopAccount } = await import("../main/electron/account");
const { loginItemLayer } = await import("../main/electron/liveness");

const signIn = (accountId: string) =>
  desktopAccount.store().write({
    credential: "credential",
    deviceKey: "key",
    accountId,
    deviceName: "Mac",
  });

// Every reconcile so far, once any that is coming has had its moment:
// the one asked for, then a beat for one that shouldn't come.
const settled = async (count: number, what: string) => {
  await waitFor(() => loginItems.length >= count, what);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return [...loginItems];
};

it("reconciles at boot, on keepReachable and on the account's id, and on nothing else", async () => {
  writeFileSync(join(dir, "clientConfig.json"), JSON.stringify({}));
  const scope = Scope.makeUnsafe();
  await Effect.runPromise(
    Layer.buildWithScope(
      loginItemLayer.pipe(
        Layer.provideMerge(ClientConfig.layer),
        Layer.provide(NodeServices.layer),
      ),
      scope,
    ),
  );
  try {
    // Signed out: no login item, keepReachable on or not.
    assert.deepEqual(await settled(1, "the boot pass"), [false]);

    signIn("account-a");
    await desktopAccount.changed({ before: null, after: "account-a" });
    assert.deepEqual(await settled(2, "the sign-in"), [false, true]);

    // A theme, a palette and a rename, then a keepReachable change: the
    // only reconcile is the last one's.
    await ClientConfig.patchClientConfig({ theme: "dark" }, []);
    await ClientConfig.patchClientConfig({ lightTheme: "latte" }, []);
    await desktopAccount.changed({ before: "account-a", after: "account-a" });
    await ClientConfig.patchClientConfig({ keepReachable: false }, []);
    assert.deepEqual(await settled(3, "keepReachable off"), [
      false,
      true,
      false,
    ]);
    await ClientConfig.patchClientConfig({}, ["keepReachable"]);
    assert.deepEqual(await settled(4, "keepReachable back on"), [
      false,
      true,
      false,
      true,
    ]);

    signIn("account-b");
    await desktopAccount.changed({ before: "account-a", after: "account-b" });
    assert.equal((await settled(5, "the switch")).length, 5);

    desktopAccount.store().clear();
    await desktopAccount.changed({ before: "account-b", after: null });
    assert.deepEqual((await settled(6, "the sign-out")).at(-1), false);
    assert.equal(loginItems.length, 6);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
