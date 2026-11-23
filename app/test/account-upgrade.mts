// A host signed in on a build before Colibrii reads, on its first start
// after the upgrade, as waiting to be signed in again rather than signed
// out, so the mirror sweep keeps its mirrors (host/process/handlers.ts,
// noteDeviceAccount). The documents are what that build wrote to
// account.json.
import { describe, expect, it } from "vitest";
import {
  type AccountShell,
  makeAccountHandlers,
} from "@shared/account/handlers";
import { profileStore } from "@shared/account/profile";

const storeOf = (doc: unknown) => {
  let raw: string | null = doc === null ? null : JSON.stringify(doc);
  return profileStore({
    readRaw: () => raw,
    writeRaw: (text) => {
      raw = text;
    },
  });
};

const OLDER = {
  v: 1,
  enc: false,
  credential: "plain",
  deviceKey: "key",
  accountId: "user_1",
  deviceName: "Server",
  acceptsCommands: true,
};

// The account calls over that store, on a device that enrolls and signs
// out without a service.
const handlersOver = (store: ReturnType<typeof storeOf>) =>
  makeAccountHandlers({
    config: () => ({
      hubUrl: "",
      app: "",
      publishableKey: "",
      webOrigin: "",
      oauthClientId: "",
    }),
    device: {
      account: async () => ({ _tag: "SignedOut", removed: false }),
      enroll: async () => {},
      signOut: async () => true,
      listDevices: async () => [],
      renameDevice: async () => {},
      setDeviceData: async () => {},
      removeDevice: async () => {},
    },
    profile: () => store,
    deviceId: async () => "device_1",
    defaultName: async () => ({ name: "Host", provisional: false }),
    detectedIcon: async () => "server",
    platform: "linux",
    sharedSignIn: () => false,
    codeSignIn: false,
    changed: () => {},
    acceptsCommandsChanged: () => {},
  } satisfies AccountShell);

describe("an older build's account.json", () => {
  it("holds an enrollment while signed in, sealed or plain, until the next write", () => {
    for (const enc of [true, false]) {
      const store = storeOf({
        v: 1,
        enc,
        credential: "sealed-or-plain",
        deviceKey: "key",
        accountId: "user_1",
        deviceName: "Server",
        acceptsCommands: true,
      });
      expect(store.enrolledBefore()).toBe(true);
      expect(store.read()).toEqual({ deviceName: "Server" });
      store.write(store.read());
      expect(store.enrolledBefore()).toBe(false);
      expect(store.read()).toEqual({ deviceName: "Server" });
    }
  });

  it("holds none signed out, a revoke parked or not, nor as this build writes it", () => {
    for (const doc of [
      null,
      { v: 1, signedOut: true, deviceName: "Server" },
      {
        v: 1,
        signedOut: true,
        deviceName: "Server",
        parked: { enc: false, credential: "old", accountId: "user_1" },
      },
      { deviceName: "Server", acceptsCommandsFor: "user_1" },
    ]) {
      expect(storeOf(doc).enrolledBefore()).toBe(false);
    }
  });

  it("holds none once the device enrolls or signs out", async () => {
    const enrolled = storeOf(OLDER);
    await handlersOver(enrolled).enroll("token", null);
    expect(enrolled.enrolledBefore()).toBe(false);
    expect(enrolled.read()).toEqual({ deviceName: "Server" });

    const signedOut = storeOf(OLDER);
    await handlersOver(signedOut).signOut(undefined, null);
    expect(signedOut.enrolledBefore()).toBe(false);
    expect(signedOut.read()).toEqual({ deviceName: "Server" });
  });
});
