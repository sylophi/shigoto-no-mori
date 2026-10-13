// Durable proof for the renderer's atoms over pushes: what a host or the
// hub link pushes, kept on the page's registry the way the boot seeds it,
// over stand-in links whose pushes the proof sends.
//
// Asserts:
//   - a device's script runs bind a started run, take its output, read
//     a failed exit as news until its page is left, stop a run over the
//     device's link, and drop a removed worktree's runs,
//   - a peer's runs come out of the hub hop, decoded, and start over
//     with the account,
//   - this machine's worktree lifecycle follows the create phases and a
//     removal under way, and a peer's removal is dropped as a new
//     session to it lands,
//   - the git fetches read per device, and a peer's start over on a new
//     session,
//   - the hub's status reaches its atom, a push beating the seed, and
//     the remote device list is rebuilt from it and the account's
//     device list (a query), each peer's command access read off it.
//
// Run: pnpm test push-atoms.
import assert from "node:assert/strict";
import { callOf, channelOf } from "@shigomori/contracts/contract";
import type { ContractModule } from "@shigomori/contracts/contract";
import { RemoteCallError } from "@shigomori/contracts/errors";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { type HubStatus, hubContract } from "@shigomori/contracts/modules/hub";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { gitContract } from "@shigomori/contracts/modules/git";
import { QueryClient } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import type { Link } from "@shared/ipc/transport";
import { pushFanOut } from "@shared/remote/rpcTransport";
import { gitFetchingAtom } from "@/hooks/git/useProjectGitFetching";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import { readsRunsOf } from "@/hooks/live/useLiveActivity";
import { activityOf, scriptRunsOf } from "@/hooks/scripts/scriptRuns";
import { worktreeLifecycleAtom } from "@/hooks/worktrees/useWorktreeLifecycle";
import { queryKeys } from "@/lib/queryKeys";
import { remoteDevicesAtom } from "@/lib/remote/devices";
import {
  hubStatusAtom,
  startRemoteDeviceSync,
} from "@/lib/remote/remoteDeviceSync";
import {
  accountsLeftAtom,
  clientLinksAtom,
  localDeviceIdAtom,
  peerSessionAtom,
  queryClientAtom,
} from "@/lib/runtime/atoms";
import type { HostApi } from "@/lib/runtime/Api";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { scriptKey } from "@/store/scriptSlot";
import { waitFor } from "./lib/checkKit.mts";

const LOCAL = "this-mac";
const PEER = "studio";

type Calls = Record<string, (input: never) => unknown>;

// A push's channel, by its module and name.
const pushChannel = (module: ContractModule, key: string) =>
  channelOf(callOf(module as typeof scriptsContract, key));

// A page's registry over two stand-in links: this machine's host (its
// own build), and the hub's side, which answers its own calls and
// carries every peer's pushes (hub:peerPush), as another build's.
function page(calls: Calls = {}) {
  const host = pushFanOut();
  const hub = pushFanOut();
  const called: { channel: string; input: unknown }[] = [];
  // How many streams follow each channel, so a push is sent once
  // something hears it, as a host's would come after the subscription.
  const following = new Map<string, number>();
  const follow = (channel: string, by: number) =>
    following.set(channel, (following.get(channel) ?? 0) + by);
  const linkOver = (fanOut: typeof host, local: boolean): Link => ({
    local,
    call: (channel, input) => {
      called.push({ channel, input });
      const answer = calls[channel];
      return answer === undefined
        ? Effect.die(new Error(`no stand-in for ${channel}`))
        : Effect.promise(async () => answer(input as never));
    },
    view: (channel) => Stream.die(new Error(`no view ${channel}`)),
    pushes: (channel) =>
      Stream.unwrap(
        Effect.sync(() => {
          follow(channel, 1);
          return fanOut.pushes(channel);
        }),
      ).pipe(Stream.ensuring(Effect.sync(() => follow(channel, -1)))),
  });
  const hostLink = linkOver(host, true);
  const hubLink = linkOver(hub, false);
  const queryClient = new QueryClient();
  const registry = AtomRegistry.make({
    initialValues: [
      [
        clientLinksAtom,
        {
          linkOf: (module: ContractModule) =>
            module === hubContract ? hubLink : hostLink,
        },
      ],
      [localDeviceIdAtom, LOCAL],
      [queryClientAtom, queryClient],
    ],
  });
  const heard = (channel: string) =>
    waitFor(() => (following.get(channel) ?? 0) > 0, `${channel} heard`);
  return {
    registry,
    queryClient,
    called,
    // A push from this machine's host.
    push: (module: ContractModule, key: string, payload: unknown) =>
      heard(pushChannel(module, key)).then(() =>
        host.emit(pushChannel(module, key), payload),
      ),
    // A push from a peer, out of the hub hop.
    peerPush: (module: ContractModule, key: string, payload: unknown) =>
      heard("hub:peerPush").then(() =>
        hub.emit("hub:peerPush", {
          deviceId: PEER,
          channel: pushChannel(module, key),
          payload,
        }),
      ),
    hubPush: (status: HubStatus) =>
      heard("hub:statusChanged").then(() =>
        hub.emit("hub:statusChanged", status),
      ),
  };
}

const valueOf = <A,>(result: AsyncResult.AsyncResult<A, unknown>) => {
  assert.ok(AsyncResult.isSuccess(result), "the atom has a value");
  return result.value;
};

const setup = { kind: "setup" } as const;

it("script runs: a run's state, output and activity, from its pushes", async () => {
  const { registry, push, called } = page({
    "scripts:cancel": () => ({ cancelled: true }),
  });
  const runs = scriptRunsOf(registry, LOCAL);
  const key = scriptKey("p1", "w1", setup);
  const stateOf = () => registry.get(runs.state).states.get(key);
  const activity = () => activityOf(registry.get(runs.state), "w1");

  await push(scriptsContract, "event", {
    runId: "r1",
    kind: "started",
    projectId: "p1",
    worktreeId: "w1",
    slot: setup,
  });
  await waitFor(() => stateOf()?.status === "running", "the run bound");
  assert.equal(activity(), "setup");

  await push(scriptsContract, "event", {
    runId: "r1",
    kind: "data",
    data: "hi\n",
  });
  await waitFor(() => stateOf()?.hasOutput === true, "the output");
  assert.deepEqual(runs.readOutput(key), ["hi\n"]);

  // Stopped over the device's link, and reading so until the exit.
  assert.equal(await runs.cancel(key), true);
  assert.deepEqual(called.at(-1), {
    channel: "scripts:cancel",
    input: { runId: "r1" },
  });
  assert.equal(stateOf()?.cancelling, true);
  await push(scriptsContract, "event", {
    runId: "r1",
    kind: "exit",
    code: null,
  });
  await waitFor(() => stateOf()?.status === "exited", "the exit");
  assert.equal(stateOf()?.cancelling, false);
  // A stop is no failure.
  assert.equal(activity(), null);

  // A failed exit is news until the worktree's page is left.
  await push(scriptsContract, "event", {
    runId: "r2",
    kind: "started",
    projectId: "p1",
    worktreeId: "w1",
    slot: setup,
  });
  await waitFor(() => stateOf()?.runId === "r2", "the second run");
  await push(scriptsContract, "event", { runId: "r2", kind: "exit", code: 1 });
  await waitFor(() => activity() === "failed", "the failure as news");
  runs.markSeen("w1");
  assert.equal(activity(), null);

  // A worktree removed outside the app takes its runs with it.
  await push(scriptsContract, "stoppedForRemovedWorktree", {
    worktreeId: "w1",
    worktreeName: "w1",
    scriptCount: 1,
  });
  await waitFor(() => stateOf() === undefined, "the runs dropped");
  registry.dispose();
});

it("script runs: a peer's come out of the hub hop and go with the account", async () => {
  const { registry, peerPush } = page();
  const key = scriptKey("p1", "w1", setup);
  const runs = scriptRunsOf(registry, PEER);
  await peerPush(scriptsContract, "event", {
    runId: "r1",
    kind: "started",
    projectId: "p1",
    worktreeId: "w1",
    slot: setup,
  });
  await waitFor(
    () => registry.get(runs.state).states.get(key)?.status === "running",
    "the peer's run bound",
  );
  // Another build's push that this one does not read is dropped.
  await peerPush(scriptsContract, "event", { runId: "r1", kind: "warp" });

  registry.update(accountsLeftAtom, (count) => count + 1);
  const after = scriptRunsOf(registry, PEER);
  assert.notEqual(after, runs, "the runs started over");
  assert.equal(registry.get(after.state).states.size, 0);
  // The new runs hear the peer as the old ones did.
  await peerPush(scriptsContract, "event", {
    runId: "r2",
    kind: "started",
    projectId: "p1",
    worktreeId: "w1",
    slot: setup,
  });
  await waitFor(
    () => registry.get(after.state).states.get(key)?.runId === "r2",
    "the next account's run bound",
  );
  registry.dispose();
});

it("worktree lifecycle: create phases and removals, per device", async () => {
  const { registry, push, peerPush } = page();
  const unmountLocal = registry.mount(worktreeLifecycleAtom(LOCAL));
  const unmountPeer = registry.mount(worktreeLifecycleAtom(PEER));
  const local = () => valueOf(registry.get(worktreeLifecycleAtom(LOCAL)));
  const peer = () => valueOf(registry.get(worktreeLifecycleAtom(PEER)));

  await push(worktreesContract, "lifecyclePhase", {
    projectId: "p1",
    worktreeId: "w1",
    phase: "setup",
  });
  await waitFor(() => local().phases.get("w1") === "setup", "the phase");
  await push(worktreesContract, "lifecyclePhase", {
    projectId: "p1",
    worktreeId: "w1",
    phase: "idle",
  });
  await waitFor(() => !local().phases.has("w1"), "the phase over");

  await push(worktreesContract, "removal", {
    projectId: "p1",
    worktreeId: "w1",
    state: "removing",
  });
  await waitFor(() => local().removing.has("w1"), "the removal under way");
  await push(worktreesContract, "removal", {
    projectId: "p1",
    worktreeId: "w1",
    state: "kept",
  });
  await waitFor(() => !local().removing.has("w1"), "the worktree kept");

  // A peer's removal whose close the dropped wire never brought is let
  // go as a new session lands.
  await peerPush(worktreesContract, "removal", {
    projectId: "p1",
    worktreeId: "w9",
    state: "removing",
  });
  await waitFor(() => peer().removing.has("w9"), "the peer's removal");
  assert.equal(local().removing.has("w9"), false, "kept per device");
  registry.update(peerSessionAtom(PEER), (count) => count + 1);
  assert.equal(peer().removing.has("w9"), false);

  unmountLocal();
  unmountPeer();
  registry.dispose();
});

it("git fetches: per device, a peer's over on a new session", async () => {
  const { registry, push, peerPush } = page();
  const fetching = (deviceId: string) =>
    valueOf(registry.get(gitFetchingAtom(deviceId)));
  assert.equal(fetching(LOCAL).size, 0);
  assert.equal(fetching(PEER).size, 0);

  await push(gitContract, "fetchActive", { projectId: "p1", active: true });
  await peerPush(gitContract, "fetchActive", { projectId: "p1", active: true });
  await waitFor(
    () => fetching(LOCAL).has("p1") && fetching(PEER).has("p1"),
    "both fetching",
  );
  await push(gitContract, "fetchActive", { projectId: "p1", active: false });
  await waitFor(() => !fetching(LOCAL).has("p1"), "this machine's done");
  assert.ok(fetching(PEER).has("p1"));

  registry.update(peerSessionAtom(PEER), (count) => count + 1);
  assert.equal(fetching(PEER).size, 0);
  registry.dispose();
});

it("git fetches: a peer's, mounted as its session lands, heard with no page reading it", async () => {
  const { registry, peerPush } = page();
  // As the boot mounts it when the peer's session lands.
  const unmount = registry.mount(gitFetchingAtom(PEER));
  registry.update(peerSessionAtom(PEER), (count) => count + 1);
  await peerPush(gitContract, "fetchActive", { projectId: "p1", active: true });
  await waitFor(
    () => valueOf(registry.get(gitFetchingAtom(PEER))).has("p1"),
    "the peer's fetch, heard before any read",
  );
  unmount();
  registry.dispose();
});

const status = (over: Partial<HubStatus> = {}): HubStatus => ({
  socket: { phase: "connected", remoteDeviceId: "", remoteAppVersion: "" },
  onlineDeviceIds: [],
  peerAppVersions: {},
  peerAcceptsCommands: {},
  peerSharesData: {},
  ...over,
});

// What a peer's entry is handed; nothing here calls it.
const noPeerApi: RendererApi["peerApi"] = () => ({}) as HostApi;

// The page api's runtime half: its calls run as they are, and no push
// reaches the sync through it.
const runtime: Pick<RendererApi, "run" | "listen" | "pushes"> = {
  run: (effect) => Effect.runPromise(effect),
  listen: () => () => {},
  pushes: () => Stream.never,
};

const studio: DeviceInfo = {
  deviceId: PEER,
  name: "Studio",
  platform: "darwin",
  icon: "desktop",
  createdAt: 0,
  lastSeenAt: null,
  online: true,
};

it("hub status and remote devices: from the hub's pushes and the device list", async () => {
  // The seed answers after a push has landed, so it is stale.
  let answerSeed: ((value: HubStatus) => void) | undefined;
  const { registry, queryClient, hubPush } = page();
  queryClient.setQueryData(queryKeys.accountDevices(), [studio]);
  const account: Pick<RendererApi["account"], "status" | "listDevices"> = {
    // Never settles: the account is not what this checks.
    status: () => Effect.never,
    listDevices: () => Effect.succeed([studio]),
  };
  // The seed is the first ask; a pass the list's landing queues asks
  // again, and hears the status as it stands.
  let asked = 0;
  let latest = status();
  const hubCalls: Pick<RendererApi["hub"], "status"> = {
    status: () =>
      (asked += 1) === 1
        ? Effect.promise(
            () =>
              new Promise<HubStatus>((resolve) => {
                answerSeed = resolve;
              }),
          )
        : Effect.succeed(latest),
  };
  const sendStatus = async (next: HubStatus) => {
    latest = next;
    await hubPush(next);
  };
  const api = {
    ...runtime,
    deviceId: LOCAL,
    account,
    hub: hubCalls,
    peerApi: noPeerApi,
  } as RendererApi;
  startRemoteDeviceSync(api, queryClient, registry, () => () => {});
  const hub = () => registry.get(hubStatusAtom);
  assert.ok(AsyncResult.isInitial(hub()), "nothing until the first snapshot");

  await sendStatus(
    status({
      onlineDeviceIds: [PEER],
      peerAppVersions: { [PEER]: "3.0.0" },
      peerAcceptsCommands: { [PEER]: false },
    }),
  );
  await waitFor(() => AsyncResult.isSuccess(hub()), "the pushed status");
  answerSeed?.(status());
  await waitFor(
    () => registry.get(remoteDevicesAtom).length === 1,
    "the peer listed",
  );
  const [device] = registry.get(remoteDevicesAtom);
  assert.equal(device?.status.phase, "connected");
  assert.equal(device?.acceptsCommands, false);
  assert.equal(commandAccessOf(LOCAL, PEER, device).canCommand, false);
  // Its runs aren't read (scripts:watch is gated): settled as none,
  // where a refused view would be asked for good. This device's own,
  // and a peer's before the registry says, are.
  assert.equal(readsRunsOf(LOCAL, PEER, false), false);
  assert.equal(readsRunsOf(LOCAL, PEER, undefined), true);
  assert.equal(readsRunsOf(LOCAL, LOCAL, undefined), true);
  // The stale seed did not roll the status back.
  assert.deepEqual(valueOf(hub()).peerAppVersions, { [PEER]: "3.0.0" });

  // An unchanged rebuild keeps the list, so its readers do not draw.
  const before = registry.get(remoteDevicesAtom);
  await sendStatus(
    status({
      onlineDeviceIds: [PEER],
      peerAppVersions: { [PEER]: "3.0.0" },
      peerAcceptsCommands: { [PEER]: false },
    }),
  );
  await sendStatus(
    status({
      onlineDeviceIds: [PEER],
      peerAppVersions: { [PEER]: "3.0.0" },
      peerAcceptsCommands: { [PEER]: true },
    }),
  );
  await waitFor(
    () => registry.get(remoteDevicesAtom)[0]?.acceptsCommands === true,
    "the peer's command access",
  );
  assert.notEqual(registry.get(remoteDevicesAtom), before);

  // Signed out: the socket stopped, no peers.
  await sendStatus(status({ socket: { phase: "stopped" } }));
  await waitFor(
    () => registry.get(remoteDevicesAtom).length === 0,
    "no peers signed out",
  );
  registry.dispose();
});

it("remote devices: a peer that stops taking commands is refused before the device list's fetch lands", async () => {
  const { registry, queryClient, hubPush } = page();
  let latest = status();
  queryClient.setQueryData(queryKeys.accountDevices(), [studio]);
  // The list's next fetch doesn't land until the case lets it: the
  // network it waits on is gone.
  let fetching = false;
  const lands: Array<(devices: DeviceInfo[]) => void> = [];
  const landed = new Promise<DeviceInfo[]>((resolve) => lands.push(resolve));
  // oxlint-disable-next-line shigomori/no-double-cast -- the sync reads only these of the page's api
  const api = {
    ...runtime,
    deviceId: LOCAL,
    account: {
      status: () => Effect.never,
      listDevices: () =>
        Effect.suspend(() => {
          fetching = true;
          return Effect.promise(() => landed);
        }),
    },
    hub: { status: () => Effect.sync(() => latest) },
    peerApi: noPeerApi,
  } as unknown as RendererApi;
  startRemoteDeviceSync(api, queryClient, registry, () => () => {});
  const peer = () => registry.get(remoteDevicesAtom)[0];
  const send = async (next: HubStatus) => {
    latest = next;
    await hubPush(next);
  };
  await send(
    status({
      onlineDeviceIds: [PEER],
      peerAppVersions: { [PEER]: "3.0.0" },
      peerAcceptsCommands: { [PEER]: true },
    }),
  );
  await waitFor(() => peer()?.acceptsCommands === true, "the peer commandable");
  void queryClient.invalidateQueries({ queryKey: queryKeys.accountDevices() });
  await send(
    status({
      onlineDeviceIds: [PEER],
      peerAppVersions: { [PEER]: "3.0.0" },
      peerAcceptsCommands: { [PEER]: false },
    }),
  );
  await waitFor(
    () => peer()?.acceptsCommands === false,
    "the refusal, with the list's fetch still out",
  );
  assert.ok(fetching, "the list's fetch was asked for");
  // The pass it held ends, for the next case's sync.
  for (const land of lands) land([studio]);
  await waitFor(() => queryClient.isFetching() === 0, "the list landed");
  registry.dispose();
});

it("hub status: a failed boot fetch falls back on the next pass's", async () => {
  const { registry, queryClient } = page();
  let asked = 0;
  // oxlint-disable-next-line shigomori/no-double-cast -- the sync reads only these of the page's api
  const api = {
    ...runtime,
    deviceId: LOCAL,
    account: {
      status: () => Effect.never,
      listDevices: () => Effect.succeed([studio]),
    },
    hub: {
      status: () =>
        (asked += 1) === 1
          ? Effect.fail(
              new RemoteCallError({ text: "the hub bridge is not up yet" }),
            )
          : Effect.succeed(status()),
    },
    peerApi: noPeerApi,
  } as unknown as RendererApi;
  startRemoteDeviceSync(api, queryClient, registry, () => () => {});
  const hub = () => registry.get(hubStatusAtom);
  await waitFor(() => asked >= 1, "the boot's fetch");
  assert.ok(AsyncResult.isInitial(hub()), "nothing while the fetch failed");
  // The device list landing runs a pass, which asks again.
  await queryClient.fetchQuery({
    queryKey: queryKeys.accountDevices(),
    queryFn: async () => [studio],
  });
  await waitFor(() => AsyncResult.isSuccess(hub()), "the pass's status");
});
