// Proof that the requests a device's settings feed follow the settings
// whoever wrote them (renderer/hooks/config/useGlobalConfig.ts,
// followDeviceSettings): the device's config view moving its `githubCli`
// switch reads gh's answers again, moving its launch tools reads the
// launcher lists again, and a move of anything else reads neither, with
// no Settings save in the window. Before, only the window's own save
// asked them again, so `sm config` or another device's form left them
// stale.
//
// Run: pnpm test device-settings-reads.
import assert from "node:assert/strict";
import { callOf, channelOf } from "@shigomori/contracts/contract";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import type { GlobalConfig } from "@shigomori/contracts/schemas";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import type { Link } from "@shared/ipc/transport";
import { pushFanOut } from "@shared/remote/rpcTransport";
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

it("gh's answers and the launch tools follow the device's settings, and nothing else does", async () => {
  const host = pushFanOut();
  let following = 0;
  const link: Link = {
    local: true,
    call: (channel) => Effect.die(new Error(`no stand-in for ${channel}`)),
    view: (channel) =>
      Stream.unwrap(
        Effect.sync(() => {
          following += 1;
          return host.pushes(channel);
        }),
      ),
    pushes: (channel) => host.pushes(channel),
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
  const launchers = shown(queryClient, keys.projectLaunchers("p1"));
  await waitFor(
    () => gh.counts.reads === 1 && launchers.counts.reads === 1,
    "the first reads",
  );

  const stop = followDeviceSettings(registry, queryClient, DEVICE);
  const config = (value: GlobalConfig) => host.emit(WATCH, value);
  await waitFor(() => following > 0, "the view followed");
  // The view's first value is no move, and the next move of anything
  // else reads neither: each later read is the one move it follows.
  config({ githubCli: true });
  config({ githubCli: true, autoPullNew: true });
  config({ githubCli: false, autoPullNew: true });
  await waitFor(() => gh.counts.reads === 2, "gh read again");
  assert.equal(launchers.counts.reads, 1);

  config({ githubCli: false, autoPullNew: true, terminal: "ghostty" });
  await waitFor(() => launchers.counts.reads === 2, "launchers read again");
  assert.equal(gh.counts.reads, 2);

  stop();
  gh.unsubscribe();
  launchers.unsubscribe();
  registry.dispose();
});
