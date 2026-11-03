// What a window does for this device's copy of the shared settings
// (renderer/lib/remote/sharedSettingsSync.ts), for a host with none: a
// peer's copy that moved is merged here, and a peer whose session lands
// is read and offered what it lacks. Without it the copy here moves
// only when a peer offers, which takes the command grant.
import { hubContract } from "@shigomori/contracts/modules/hub";
import {
  type SharedSettingsDoc,
  SharedSettingsDocSchema,
} from "@shigomori/contracts/schemas";
import { exchangeSharedSettings } from "@shigomori/contracts/sharedSettings";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostPushes from "@host/lib/HostPushes";
import * as SharedSettingsStore from "@host/lib/sharedSettings/store";
import { hubHandlers } from "@host/process/wires";

const decodeDoc = Schema.decodeUnknownPromise(SharedSettingsDocSchema);

// A peer's copy, as one of its calls answers it.
const peerDoc = (deviceId: string, channel: string, input?: unknown) =>
  Effect.runPromise(hubHandlers().invokeOnPeer(deviceId, channel, input)).then(
    decodeDoc,
  );

export const followSharedSettings = Layer.effectDiscard(
  Effect.gen(function* () {
    const run =
      yield* FiberSet.makeRuntimePromise<
        Effect.Services<ReturnType<typeof SharedSettingsStore.merge>>
      >();
    const mergeHere = (doc: SharedSettingsDoc) =>
      run(SharedSettingsStore.merge(doc));

    const peerPushes = yield* HostPushes.payloads(hubContract, "peerPush");
    yield* peerPushes.pipe(
      Stream.filter((push) => push.channel === "sharedSettings:changed"),
      Stream.runForEach((push) =>
        Effect.sync(() => {
          decodeDoc(push.payload)
            .then(mergeHere)
            .catch(() => {});
        }),
      ),
      Effect.forkScoped,
    );

    // A key in peerAppVersions is a session up.
    let landed = new Set<string>();
    const statuses = yield* HostPushes.payloads(hubContract, "statusChanged");
    yield* statuses.pipe(
      Stream.runForEach(({ peerAppVersions }) =>
        Effect.sync(() => {
          const now = new Set(Object.keys(peerAppVersions));
          for (const deviceId of now) {
            if (landed.has(deviceId)) continue;
            exchangeSharedSettings(
              { merge: ({ doc }) => mergeHere(doc) },
              {
                read: () => peerDoc(deviceId, "sharedSettings:read"),
                merge: (input) =>
                  peerDoc(deviceId, "sharedSettings:merge", input),
              },
            ).catch(() => {});
          }
          landed = now;
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
