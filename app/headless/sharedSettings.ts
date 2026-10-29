// What a window does for this device's copy of the shared settings
// (renderer/lib/remote/sharedSettingsSync.ts), for a host with none: a
// peer's copy that moved is merged here, and a peer whose session lands
// is read and offered what it lacks. Without it the copy here moves
// only when a peer offers, which takes the command grant.
import { SharedSettingsDocSchema } from "@shigomori/contracts/schemas";
import type { SharedSettingsDoc } from "@shigomori/contracts/schemas";
import { exchangeSharedSettings } from "@shigomori/contracts/sharedSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  sharedSettingsCopy,
  sharedSettingsLoaded,
} from "@host/lib/sharedSettings/store";
import { hubHandlers, onHubStatus, onPeerPush } from "@host/process/wires";

const decodeDoc = Schema.decodeUnknownPromise(SharedSettingsDocSchema);

const mergeHere = async (doc: SharedSettingsDoc) => {
  await Effect.runPromise(sharedSettingsLoaded);
  return sharedSettingsCopy.merge(doc);
};

export function followSharedSettings(): void {
  onPeerPush((push) => {
    if (push.channel !== "sharedSettings:changed") return;
    decodeDoc(push.payload)
      .then(mergeHere)
      .catch(() => {});
  });
  // A key in peerAppVersions is a session up.
  let landed = new Set<string>();
  onHubStatus(({ peerAppVersions }) => {
    const now = new Set(Object.keys(peerAppVersions));
    for (const deviceId of now) {
      if (landed.has(deviceId)) continue;
      const peer = (channel: string, input?: unknown) =>
        hubHandlers().invokeOnPeer(deviceId, channel, input).then(decodeDoc);
      exchangeSharedSettings(
        { merge: ({ doc }) => mergeHere(doc) },
        {
          read: () => peer("sharedSettings:read"),
          merge: (input) => peer("sharedSettings:merge", input),
        },
      ).catch(() => {});
    }
    landed = now;
  });
}
