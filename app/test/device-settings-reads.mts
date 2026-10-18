// Proof that gh's answers follow a device's `githubCli` switch whoever
// moved it (renderer/hooks/config/useGlobalConfig.ts,
// followDeviceSettings): the device's config view turning the switch
// reads them again, and nothing else does, an explicit default over an
// absent key included. Before, only the window's own Settings save asked
// them again, so `sm config` or another device's form left them stale.
// The rest of a device's settings reach its requests through the push
// watch's externalChange (push-reads).
//
// Run: pnpm test device-settings-reads.
import assert from "node:assert/strict";
import { callOf, channelOf } from "@shigomori/contracts/contract";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { GlobalConfig } from "@shigomori/contracts/schemas";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import type { Link } from "@shared/ipc/transport";
import { followDeviceSettings } from "@/hooks/config/useGlobalConfig";
import { queryKeysFor } from "@/lib/queryKeys";
import {
  clientLinksAtom,
  localDeviceIdAtom,
  queryClientAtom,
} from "@/lib/runtime/atoms";
import { waitFor } from "./lib/checkKit.mts";

const DEVICE = "this-mac";
const WATCH = channelOf(callOf(globalConfigContract, "watch"));

function shown(client: QueryClient, queryKey: readonly unknown[]) {
  const counts = { reads: 0 };
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: async () => {
      counts.reads += 1;
      return counts.reads;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { counts, unsubscribe };
}

it("gh's answers follow the device's githubCli switch, and nothing else moves them", async () => {
  // The device's config view, its values sent by hand once it listens.
  const listeners = new Set<(value: GlobalConfig) => void>();
  const link: Link = {
    local: true,
    call: (channel) => Effect.die(new Error(`no stand-in for ${channel}`)),
    view: (channel) =>
      channel === WATCH
        ? Stream.callback<unknown>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const listen = (value: GlobalConfig) => {
                  Queue.offerUnsafe(queue, value);
                };
                listeners.add(listen);
                return listen;
              }),
              (listen) => Effect.sync(() => listeners.delete(listen)),
            ),
          )
        : Stream.die(new Error(`no view ${channel}`)),
    pushes: () => Stream.never,
  };
  const queryClient = new QueryClient();
  const registry = AtomRegistry.make({
    initialValues: [
      [clientLinksAtom, { linkOf: () => link }],
      [localDeviceIdAtom, DEVICE],
      [queryClientAtom, queryClient],
    ],
  });
  const keys = queryKeysFor(DEVICE);
  const gh = shown(queryClient, keys.githubCliReadiness());
  await waitFor(() => gh.counts.reads === 1, "the first read");

  const stop = followDeviceSettings(registry, queryClient, DEVICE);
  await waitFor(() => listeners.size > 0, "the view followed");
  const config = (value: GlobalConfig) => {
    for (const listen of listeners) listen(value);
  };
  // An absent switch, then the same switch spelled out beside other
  // moves, reads nothing: the next read is the switch's own move.
  config({});
  config({ githubCli: true, autoPullNew: true, terminal: "ghostty" });
  config({ githubCli: false, autoPullNew: true, terminal: "ghostty" });
  await waitFor(() => gh.counts.reads === 2, "gh read again");
  config({ githubCli: false, launchers: [], hiddenLaunchers: ["app:zed"] });
  config({});
  await waitFor(() => gh.counts.reads === 3, "gh read again on the way back");
  assert.equal(gh.counts.reads, 3);

  stop();
  gh.unsubscribe();
  registry.dispose();
});
