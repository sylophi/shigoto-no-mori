// Durable proof for the CLI's cross-device verbs (`sm devices`, `sm
// worktrees send|bring|mirror|unmirror|mirrors`) end to end: the REAL sm
// binary (built from packages/cli by this check) finds the REAL loopback
// (host/socket/loopback.ts) through loopback.json in a sandboxed data
// dir, proves the token in the link's handshake, and the loopback
// serves the REAL control handlers (host/ipc/modules/control.ts), which
// run the REAL send and pull
// orchestrators over a REAL direct websocket to device A, which run
// the engine for every git step against real fixture repos.
// The account's device registry is the one double (it is an HTTP read
// of the hub), and the mirror engine is a recording stand-in: its real
// runs are test/mirror.mts's, while what is pinned here is what the
// control layer asks of it. Asserts:
//   - with no loopback.json, a dead pid, a dead port or a wrong token,
//     the CLI says the app isn't running (coded app-not-running), and
//     the loopback serves nothing before a hello.
//   - a loopback.json wiped under the running app comes back.
//   - `devices` names the peers, leaves a browser out, and reports
//     offline, not-sharing, no-grant and ready per device for the
//     repo, and a peer that isn't sharing takes no send and lists no
//     worktrees when named.
//   - `send` lands a dirty worktree on the peer with its commit and its
//     uncommitted work, streams progress events, picks the only ready
//     device unasked, and refuses an unknown device, an ambiguous one
//     and one that doesn't accept commands, each with its code.
//   - a repeat send is refused in the peer's words, and `--source
//     teardown` removes the local source through the send's receipt.
//   - `list --remote` lists the peer's worktrees in list's own shape,
//     `bring` with none points there, and with one (by branch) lands
//     it here and shelves the source over the wire,
//     and a source fate the peer refuses leaves the bring standing
//     with exit 3 and the reason.
//   - `mirror` sends the worktree and opens a session labelled with
//     the copy on the peer, a second `mirror` answers with the running
//     one, and `unmirror` is refused until the follower reports synced
//     (stop-unconfirmed), then removes the peer's copy.
//   - `send` to a peer with no checkout of the repo (the sending side
//     on a registry of its own) clones the repo there first, in the
//     dialogs' default place, and lands the copy in the clone, where
//     `devices` said it would take a send and `bring` from it was
//     refused as holding no checkout.
//   - `mirror --from` asks the peer to run the mirror (its
//     mirror:startTo, on its own engine) and send the copy here,
//     relaying its progress, with no need of this device's own switch:
//     the ask leaves an invitation (host/mirror/invites.ts, whose
//     rules are mirror-invites.mts's) for the peer's original. The
//     copy is local, a repeat from either end answers with it, and
//     `unmirror` removes it through the peer, original kept.
//
// Every worktree is named with -p: a landed copy keeps its source's
// folder name, and with both projects in one registry the bare name
// would be ambiguous.
//
// Both "devices" share one node process and one sandboxed data dir
// holding two projects (source and target, one repo identity), as in
// test/sync-transfer.mts: what separates them is the direct wire.
// Run: pnpm test control.
import { callOf } from "@shigomori/contracts/contract";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { buildClient } from "@shared/ipc/buildClient";
import {
  ControlPeerWorktreeSchema,
  ControlTransferResultSchema,
  controlContract,
} from "@shigomori/contracts/modules/control";
import {
  MIRROR_LABEL_MODE,
  mirrorContract,
  type MirrorGitStatus,
} from "@shigomori/contracts/modules/mirror";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { shigomoriContract } from "@shigomori/contracts/modules/shigomori";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { registerHostContract } from "@shared/ipc/registerContract";
import { hostContext, runHost } from "./lib/adapters.mts";
import type { HostServices } from "@host/process/services";
import type { ClientTransport, HandlerContext } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import {
  type RuntimeInfo,
  type WorktreeRemoval,
  WorktreeSchema,
} from "@shigomori/contracts/schemas";
import { loose } from "@shigomori/contracts/schemas/loose";
import { strict } from "@shigomori/contracts/schemas/strict";
import { only } from "@shigomori/contracts/util/only";
import {
  controlHandlers,
  controlTransfers,
  followTransfer,
} from "@host/ipc/modules/control";
import { bring, send } from "@host/lib/control/ops";
import { setControlImpl } from "@host/lib/control/peers";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import {
  isTransferSession,
  setMirrorImpl,
  type MirrorCreateInput,
  type MirrorImpl,
  type MirrorSessionRaw,
} from "@host/mirror/registry";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { runtimeHandlers } from "@host/ipc/modules/runtime";
import { shigomoriHandlers } from "@host/ipc/modules/shigomori";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { syncHandlers } from "@host/ipc/modules/sync";
import {
  setWorktreeRemovalBroadcaster,
  worktreesHandlers,
} from "@host/ipc/modules/worktrees";
import { setPeerReach } from "@host/ipc/peerSync";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import { listMirrorInvites } from "@host/mirror/invites";
import * as Loopback from "@host/socket/loopback";
import { createLinkRegistrar } from "@host/socket/server";
import * as HostPushes from "@host/lib/hostPushes";
import * as Views from "@host/lib/views";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { LinkUnauthenticatedError } from "@shigomori/contracts/errors";
import { LoopbackGroup } from "@shigomori/contracts/link";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import {
  cliFailureMessage,
  type CliResult,
  createCliRunner,
  delay,
  makeTracker,
} from "./lib/checkKit.mts";
import { secondEngine } from "./lib/smBinary.mts";
import { afterAll, beforeAll, it } from "vitest";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { bootDirectWire } from "./lib/directBoot.mts";

const fixture = cliSandbox("sm-control-check-");
const { sandbox, dataDir, git, gitOut, runCli, sm } = fixture;
const { addWorktree, projectIdOf } = fixture;
const loopbackFile = join(dataDir, Loopback.LOOPBACK_FILE);

type View = (input: unknown) => Stream.Stream<unknown, unknown, HostServices>;

// The REAL loopback on `file`, serving the control contract's `handlers`
// and `transfers`, built on `run`'s engine: this device's, or a second
// one's.
async function startLoopback(options: {
  readonly file: string;
  readonly handlers: EffectHandlers<
    typeof controlContract,
    HandlerContext,
    HostServices
  >;
  readonly transfers: Readonly<Record<string, View>>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  // The services held back until `ready`, as the app's root holds them
  // until its graph is up.
  readonly late?: boolean;
}) {
  const registrar = createLinkRegistrar();
  registerHostContract(
    controlContract,
    options.handlers,
    {
      handle: (channel, fn) => registrar.handle(channel, fn),
      broadcastAll: () => {},
    },
    { validateOutputs: true },
  );
  for (const [key, transfer] of Object.entries(options.transfers)) {
    registrar.view(`control:${key}`, transfer);
  }
  // The proof file's host services, which the handlers and transfers
  // answer on.
  const host = await hostContext();
  const scope = Effect.runSync(Scope.make());
  const handedOver = Deferred.makeUnsafe<Context.Context<HostServices>>();
  let services: Context.Context<HostServices> | undefined;
  const ready = () => {
    if (services !== undefined) {
      Deferred.doneUnsafe(handedOver, Exit.succeed(services));
    }
  };
  const context = await options.run(
    Layer.buildWithScope(
      Layer.unwrap(
        Effect.map(Effect.context<HostServices>(), (built) => {
          services = built;
          if (options.late !== true) ready();
          return Loopback.layer({
            registrar,
            deviceId: () => "B",
            appVersion: "9.9.9",
            file: () => options.file,
            services: Deferred.await(handedOver),
          });
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            StoreChanges.layer,
            HostPushes.layer,
            Views.layer,
          ).pipe(Layer.provideMerge(Layer.succeedContext(host))),
        ),
      ),
      scope,
    ) as Effect.Effect<Context.Context<Loopback.Loopback>, never, never>,
  );
  return {
    ready,
    loopback: Context.get(context, Loopback.Loopback),
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

// A call on the loopback with no handshake before it, as a stranger to
// the token would make: its failure.
const callWithoutHello = (port: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}`);
      const protocol = yield* RpcClient.makeProtocolSocket().pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerSchemaBinary()),
      );
      // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
      const client = (yield* RpcClient.make(LoopbackGroup, {
        flatten: true,
      }).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      )) as unknown as (
        tag: string,
        payload: unknown,
      ) => Effect.Effect<unknown, unknown>;
      return yield* Effect.flip(client("control:devices", {}));
    }).pipe(
      Effect.scoped,
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    ),
  );

// The final {ok} document of a run, and its progress events.
const finalDoc = (result: CliResult) =>
  result.docs.findLast((doc) => typeof doc.ok === "boolean");
const progressOf = (result: CliResult) =>
  result.docs.filter((doc) => doc.event === "progress");

// A finished run's {ok: true} document is the control op's own answer
// with the CLI's ok (and, on a transfer or a stop, its caveats) on top.
const okFields = { ok: Schema.Literal(true) };
const caveatFields = { ...okFields, caveats: Schema.Array(Schema.String) };
const DevicesDocSchema = strict(
  Schema.Struct({
    ...callOf(controlContract, "devices").successSchema.struct.fields,
    ...okFields,
  }),
);
const TransferDocSchema = strict(
  Schema.Struct({
    ...ControlTransferResultSchema.struct.fields,
    ...caveatFields,
  }),
);
const MirrorsDocSchema = strict(
  Schema.Struct({
    ...callOf(controlContract, "mirrors").successSchema.struct.fields,
    ...okFields,
  }),
);
const StopDocSchema = strict(
  Schema.Struct({
    ...callOf(controlContract, "mirrorStop").successSchema.struct.fields,
    ...caveatFields,
  }),
);
// A refused run's {ok: false} document.
const RefusalDocSchema = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.optional(Schema.String),
  error: Schema.String,
});
// list --remote's rows: list's worktree, each saying whose it is.
const RemoteRowsSchema = Schema.Array(
  Schema.Struct({
    ...WorktreeSchema.fields,
    device: ControlPeerWorktreeSchema.struct.fields.device,
  }),
);
const decodeDevicesDoc = Schema.decodeUnknownSync(DevicesDocSchema);
const decodeTransferDoc = Schema.decodeUnknownSync(TransferDocSchema);
const decodeMirrorsDoc = Schema.decodeUnknownSync(MirrorsDocSchema);
const decodeStopDoc = Schema.decodeUnknownSync(StopDocSchema);
const devicesDoc = (result: CliResult) => decodeDevicesDoc(finalDoc(result));
const transferDoc = (result: CliResult) => decodeTransferDoc(finalDoc(result));
const mirrorsDoc = (result: CliResult) => decodeMirrorsDoc(finalDoc(result));
const stopDoc = (result: CliResult) => decodeStopDoc(finalDoc(result));
const refusalDoc = Schema.decodeUnknownSync(RefusalDocSchema);
const remoteRows = Schema.decodeUnknownSync(RemoteRowsSchema);
const looseRows = Schema.decodeUnknownSync(
  Schema.Array(loose(Schema.Struct({ id: Schema.String }))),
);

async function refused(
  args: string[],
  code: string | undefined,
  pattern?: RegExp,
) {
  const result = await runCli(args);
  assert.equal(result.code, 1, `sm ${args.join(" ")} should exit 1`);
  const doc = refusalDoc(finalDoc(result));
  assert.equal(doc.code, code, `sm ${args.join(" ")}: ${doc.error}`);
  if (pattern !== undefined) assert.match(doc.error, pattern);
  return doc;
}

// One row of the account's device registry, as the hub lists it.
const registered = (
  deviceId: string,
  name: string,
  platform = "darwin",
): DeviceInfo => ({
  deviceId,
  name,
  platform,
  icon: "laptop",
  createdAt: 1,
  lastSeenAt: null,
  online: true,
});

// The mirror engine's stand-in: records what the control layer asks
// of it and reports the sessions it was asked to create. `git` is the
// follower's verdict the stop guard reads.
function fakeMirrorEngine() {
  const sessions = new Map<string, Types.Mutable<MirrorSessionRaw>>();
  const state: {
    created: MirrorCreateInput[];
    terminated: string[];
    git: MirrorGitStatus["status"];
  } = { created: [], terminated: [], git: "following" };
  let next = 0;
  const endpoint = {
    connected: true,
    scanned: true,
    directories: 0,
    files: 0,
    symbolicLinks: 0,
    totalFileSize: 0,
    problems: [],
    excludedProblems: 0,
  };
  const impl: MirrorImpl = {
    status: Effect.succeed("running"),
    sessions: Effect.sync(() => [...sessions.values()]),
    create: (input) =>
      Effect.sync(() => {
        next += 1;
        const session = `sync_fake${next}`;
        state.created.push(input);
        sessions.set(session, {
          session,
          name: input.name,
          labels: input.labels,
          localRoot: input.localRoot,
          deviceId: input.deviceId,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          remoteRoot: input.remoteRoot,
          paused: false,
          ignores: [...input.ignores],
          createdAt: Date.now(),
          status: "watching",
          statusText: "Watching for changes",
          successfulCycles: 1,
          conflicts: [],
          excludedConflicts: 0,
          local: endpoint,
          remote: endpoint,
        });
        return session;
      }),
    recreate: () => Effect.die(new Error("not in this check")),
    terminate: (session) =>
      Effect.sync(() => {
        state.terminated.push(session);
        sessions.delete(session);
      }),
    pause: (session) =>
      Effect.sync(() => {
        const raw = sessions.get(session);
        assert.ok(raw, `no session ${session}`);
        raw.paused = true;
      }),
    resume: (session) =>
      Effect.sync(() => {
        const raw = sessions.get(session);
        assert.ok(raw, `no session ${session}`);
        raw.paused = false;
      }),
    gitStatus: () => ({ status: state.git, detail: "" }),
    refreshGit: () => Effect.succeed({ status: state.git, detail: "" }),
    history: () => [],
    noteEvent: () => {},
    forgetHistory: () => {},
    moveHistory: () => {},
  };
  return { state, impl };
}

const { track, teardown } = makeTracker();
afterAll(async () => {
  await teardown();
  await fixture.remove();
});

let sourceRepo: string;
let targetRepo: string;
let sendPath: string;
let tearPath: string;
let mirrorPath: string;
let peerPath: string;
let inPath: string;
let targetProjectId: string;
let sourceProjectId: string;
let engine: ReturnType<typeof fakeMirrorEngine>;
let engineA: ReturnType<typeof fakeMirrorEngine>;
let listener: Awaited<ReturnType<typeof bootDirectWire>>["listener"];
let peerA: Awaited<ReturnType<typeof bootDirectWire>>["peerA"];
let connected: string[];
let peerOwns: string;
let removalsOf: (
  worktreeId: string,
) => (WorktreeRemoval & { endedThen: string[] })[];
let control: Awaited<ReturnType<typeof startLoopback>>;
let published: Record<string, unknown>;
let mirrorsCreated: () => MirrorCreateInput[];

beforeAll(async () => {
  await fixture.buildSm();

  // Source repo (this device, B) and its clone (the peer, A), one repo
  // identity between them.
  sourceRepo = join(sandbox, "source");
  await git(sandbox, ["init", "-q", "-b", "main", "source"]);
  await fixture.disableAutoGc(sourceRepo);
  await fixture.commitFile(sourceRepo, "readme.txt", "base\n", "base");
  targetRepo = join(sandbox, "target");
  await git(sandbox, ["clone", "-q", "--", sourceRepo, "target"]);
  await fixture.disableAutoGc(targetRepo);
  sendPath = await addWorktree(sourceRepo, "wt-send", "feat-send", "s.txt");
  writeFileSync(join(sendPath, "draft.txt"), "uncommitted\n");
  tearPath = await addWorktree(sourceRepo, "wt-tear", "feat-tear", "t.txt");
  mirrorPath = await addWorktree(
    sourceRepo,
    "wt-mirror",
    "feat-mirror",
    "m.txt",
  );
  // What `bring` finds on the peer and lands here. It lives in the
  // source repo because a pull lands in the registry's first identity
  // match (the target): see peerOwns below.
  peerPath = await addWorktree(sourceRepo, "wt-peer", "feat-peer", "p.txt");
  writeFileSync(join(peerPath, "peer-draft.txt"), "peer uncommitted\n");
  // What `mirror --from` copies here.
  inPath = await addWorktree(sourceRepo, "wt-in", "feat-in", "i.txt");

  await fixture.useCli();
  // Target first: the peer's identity scan takes the first registry
  // match, which must be the peer's own checkout.
  targetProjectId = await projectIdOf(targetRepo);
  sourceProjectId = await projectIdOf(sourceRepo);
});

it("no loopback.json, a dead pid and a dead port all read as app-not-running", async () => {
  // ---- (1) No app: every way loopback.json can be wrong reads as
  // "the app isn't running", before any server exists.
  await refused(["devices"], "app-not-running", /isn't running/);
  writeFileSync(
    loopbackFile,
    JSON.stringify({ pid: 2 ** 22 - 3, port: 1, token: "x", appVersion: "1" }),
  );
  await refused(["devices"], "app-not-running");
  writeFileSync(
    loopbackFile,
    JSON.stringify({ pid: process.pid, port: 1, token: "x", appVersion: "1" }),
  );
  await refused(["devices"], "app-not-running");
});

it("loopback.json is owner-only, a call before the hello is refused, and a stale token reads as app-not-running", async () => {
  // Each device's mirror engine. B's is the slot's own. The peer
  // runs the mirrors whose original it holds (mirror --from), on its
  // own engine: the slot is process-wide, so a mirror call on A's
  // wire swaps A's in for its duration. The calls come one at a
  // time (each CLI run is awaited), B's side idle meanwhile.
  engine = fakeMirrorEngine();
  engineA = fakeMirrorEngine();
  engineA.state.git = "synced";
  setMirrorImpl(engine.impl);
  // A's engine is swapped in for the run of each of A's handlers.
  const asA =
    <I, A, E, R>(
      run: (input: I, ctx: HandlerContext) => Effect.Effect<A, E, R>,
    ) =>
    (input: I, ctx: HandlerContext) =>
      Effect.acquireUseRelease(
        Effect.sync(() => setMirrorImpl(engineA.impl)),
        () => run(input, ctx),
        () => Effect.sync(() => setMirrorImpl(engine.impl)),
      );
  const mirrorOnA: EffectHandlers<
    typeof mirrorContract,
    HandlerContext,
    HostServices
  > = {
    list: asA(mirrorHandlers.list),
    startTo: asA(mirrorHandlers.startTo),
    startFrom: asA(mirrorHandlers.startFrom),
    stop: asA(mirrorHandlers.stop),
    release: asA(mirrorHandlers.release),
    pause: asA(mirrorHandlers.pause),
    resume: asA(mirrorHandlers.resume),
    setIgnores: asA(mirrorHandlers.setIgnores),
    history: asA(mirrorHandlers.history),
    // The stream is served apart from the engine slot.
    openStream: mirrorHandlers.openStream,
    gitState: asA(mirrorHandlers.gitState),
    applyGitState: asA(mirrorHandlers.applyGitState),
  };
  const runtimeFacts: Omit<RuntimeInfo, "homedir"> = {
    dataDir,
    dataDirSource: "env",
    atDefaultDataDir: false,
    canonicalDataDirName: ".smd",
  };
  ({ listener, peerA } = await bootDirectWire(track, {
    contracts: [
      [syncContract, syncHandlers],
      [worktreesContract, worktreesHandlers],
      [projectsContract, projectsHandlers],
      [mirrorContract, mirrorOnA],
      [shigomoriContract, shigomoriHandlers],
      [worktreeDataContract, worktreeDataHandlers],
      // The peer's home, which a send's default clone place reads.
      // The data-dir facts beside it need a booted data dir, which
      // the sandbox's seeded one is not, and are not read here.
      [
        runtimeContract,
        {
          ...runtimeHandlers,
          info: () =>
            Effect.succeed({
              ...runtimeFacts,
              homedir: homedir(),
            }),
        },
      ],
    ],
  }));
  // The account as the hub would list it: this device, the peer, a
  // machine that is signed in but away, and a browser.
  connected = ["A"];
  const registry = [
    registered("B", "Agent Box"),
    registered("A", "Studio Mac"),
    registered("C", "Studio Laptop"),
    registered("W", "Chrome on macOS", "web"),
  ];
  // Which of the two projects the peer answers as its checkout of
  // the repo. Both devices read one registry here, so the peer's
  // projects:list holds both: a send's copy lands in the target (the
  // peer's own identity scan), and for the bring the roles swap, the
  // peer's worktree living in the source and landing in the target.
  peerOwns = targetProjectId;
  const peerTransport: ClientTransport = {
    ...peerA.transport,
    invoke: async (channel, input) => {
      const result = await peerA.transport.invoke(channel, input);
      return channel === "projects:list"
        ? // Loose: the host under test gets the peer's rows as sent.
          looseRows(result).toSorted(
            (a, b) => Number(b.id === peerOwns) - Number(a.id === peerOwns),
          )
        : result;
    },
  };
  setControlImpl({
    listDevices: Effect.sync(() => registry),
    directPeers: Effect.sync(() =>
      Object.fromEntries(
        connected.map((id) => [
          id,
          {
            acceptsCommands: listener.acceptsCommands(),
            sharesData: listener.sharesData(),
          },
        ]),
      ),
    ),
  });
  // Every reach into the peer: its contracts, and the session's byte
  // channels, which a move's source link rides.
  setPeerReach({
    transportFor: () => peerTransport,
    channelsFor: () => peerA.channels,
    thisDeviceId: () => "B",
  });
  // The delete's removal, as the host fans it out to every window and
  // peer. Each record notes which sessions had ended by then: the
  // copy a stop removes is announced only once its session is gone,
  // since the delete follows the terminate.
  const removals: (WorktreeRemoval & { endedThen: string[] })[] = [];
  setWorktreeRemovalBroadcaster((payload) =>
    removals.push({
      ...payload,
      endedThen: [...engine.state.terminated, ...engineA.state.terminated],
    }),
  );
  removalsOf = (worktreeId: string) =>
    removals.filter((entry) => entry.worktreeId === worktreeId);

  control = await startLoopback({
    file: loopbackFile,
    handlers: controlHandlers,
    transfers: controlTransfers,
    run: runHost,
    late: true,
  });
  track(control.stop);

  // ---- (2) The published file and the handshake.
  published = JSON.parse(readFileSync(loopbackFile, "utf8"));
  assert.equal(published["pid"], process.pid);
  assert.equal(published["appVersion"], "9.9.9");
  assert.equal(
    statSync(loopbackFile).mode & 0o077,
    0,
    "loopback.json must be owner-only: it carries the token",
  );
  assert.ok(
    (await callWithoutHello(published["port"] as number)) instanceof
      LinkUnauthenticatedError,
    "a call before any hello is refused",
  );
  writeFileSync(
    loopbackFile,
    JSON.stringify({ ...published, token: "stale-token" }),
  );
  await refused(["devices"], "app-not-running");
  writeFileSync(loopbackFile, JSON.stringify(published));

  // A call that comes before the services are handed over waits for
  // them, and is answered once they are.
  const early = sm("devices");
  assert.equal(
    await Promise.race([early.then(() => "answered"), delay(500)]),
    undefined,
    "a call before the services was answered",
  );
  control.ready();
  assert.equal((await early).code, 0);
});

it("devices: names the peers, skips the browser, and reports offline, not-sharing, no-grant and ready for the repo", async () => {
  // ---- (3) devices: standing per device for the repo.
  const devicesOf = async (...args: string[]) =>
    devicesDoc(await sm("devices", ...args));
  const ungranted = await devicesOf("-p", "source");
  assert.deepEqual(ungranted.thisDevice, {
    deviceId: "B",
    name: "Agent Box",
  });
  assert.deepEqual(
    ungranted.devices.map((device) => [device.name, device.block]),
    [
      ["Studio Mac", "no-grant"],
      ["Studio Laptop", "offline"],
    ],
    "the browser is left out, the away machine is offline, the peer is read-only",
  );
  await refused(
    ["worktrees", "send", "wt-send", "-p", "source"],
    "device-blocked",
    /"Studio Mac" doesn't accept commands/,
  );
  listener.setAccepts(true);
  const granted = await devicesOf("-p", "source");
  const [mac] = granted.devices;
  assert.ok(mac !== undefined, "the peer is listed");
  assert.equal(mac.block, undefined);
  assert.equal(mac.projectId, targetProjectId);
  // Sharing off outranks the grant, with or without a repo asked about.
  listener.setSharing(false);
  try {
    assert.deepEqual(
      (await devicesOf("-p", "source")).devices.map((device) => [
        device.name,
        device.block,
      ]),
      [
        ["Studio Mac", "not-sharing"],
        ["Studio Laptop", "offline"],
      ],
    );
    assert.equal(
      (await devicesOf()).devices.find((device) => device.name === "Studio Mac")
        ?.block,
      "not-sharing",
    );
    await refused(
      ["worktrees", "send", "wt-send", "-p", "source", "--to", "Studio Mac"],
      "device-blocked",
      /"Studio Mac" doesn't share with other devices/,
    );
    await refused(
      ["worktrees", "list", "--remote", "-p", "source", "--from", "Studio Mac"],
      "device-blocked",
      /"Studio Mac" doesn't share with other devices/,
    );
  } finally {
    listener.setSharing(true);
  }
});

it("send: refuses an unknown, an ambiguous and an offline device by code, lands a dirty worktree on the only ready one with streamed progress, and passes the peer's refusal of a repeat through", async () => {
  // ---- (4) send: device resolution, then the transplant itself.
  await refused(
    ["worktrees", "send", "wt-send", "-p", "source", "--to", "nobody"],
    "no-device",
    /No device is named "nobody"/,
  );
  await refused(
    ["worktrees", "send", "wt-send", "-p", "source", "--to", "studio"],
    "ambiguous-device",
    /"Studio Mac", "Studio Laptop"/,
  );
  await refused(
    ["worktrees", "send", "wt-send", "-p", "source", "--to", "Studio Laptop"],
    "device-blocked",
    /not connected/,
  );
  const usage = await runCli([
    "worktrees",
    "send",
    "wt-send",
    "-p",
    "source",
    "--source",
    "burn",
  ]);
  assert.equal(usage.code, 2, "a bad --source is a usage error");

  const sendRun = await sm("worktrees", "send", "wt-send", "-p", "source");
  const sent = transferDoc(sendRun);
  assert.equal(
    sent.device.name,
    "Studio Mac",
    "the only ready device is picked",
  );
  assert.equal(sent.worktree.branch, "feat-send");
  assert.equal(sent.captured, true);
  assert.equal(sent.dirtyApplied, true);
  assert.deepEqual(sent.source, { fate: "keep", done: true });
  assert.deepEqual(sent.caveats, []);
  assert.equal(
    readFileSync(join(sent.worktree.path, "s.txt"), "utf8"),
    "feat-send\n",
  );
  assert.equal(
    readFileSync(join(sent.worktree.path, "draft.txt"), "utf8"),
    "uncommitted\n",
    "the uncommitted work landed on the peer",
  );
  const steps = new Set(progressOf(sendRun).map((doc) => doc.step));
  for (const step of ["capture", "transfer", "create", "apply"]) {
    assert.ok(steps.has(step), `progress never reported the ${step} step`);
  }
  assert.equal(existsSync(sendPath), true, "--source keep leaves the source");
  await refused(
    ["worktrees", "send", "wt-send", "-p", "source", "--to", "Studio Mac"],
    // The peer's own refusal, passed through in its words, uncoded.
    undefined,
    /The other device answered: feat-send is already checked out/,
  );
});

it("send --source teardown: the local source is removed once the copy holds it", async () => {
  // ---- (5) send --source teardown, through the send's own receipt.
  const torn = transferDoc(
    await sm(
      "worktrees",
      "send",
      "wt-tear",
      "-p",
      "source",
      "--to",
      "A",
      "--source",
      "teardown",
    ),
  );
  assert.deepEqual(torn.source, { fate: "teardown", done: true });
  assert.equal(existsSync(tearPath), false, "the source is removed");
  assert.equal(existsSync(torn.worktree.path), true, "the copy stays");
});

it("list --remote names the peer's worktrees, and bring: points there when given none, refuses an unknown one by code, lands one by branch with its uncommitted work, exits 3 naming the source fate that didn't hold, and shelves a source the peer will shelve", async () => {
  // ---- (6) bring: the list, then the pull, shelving the source.
  peerOwns = sourceProjectId;
  // list's own shape, an array of worktrees, each saying whose it is.
  const remoteList = async (...args: string[]) =>
    remoteRows(
      (await sm("worktrees", "list", "--remote", "-p", "target", ...args))
        .docs[0],
    );
  const listing = await remoteList();
  assert.ok(Array.isArray(listing), "list --remote emits list's array");
  const peerRow = listing.find((wt) => wt.branch === "feat-peer");
  assert.ok(peerRow, `the remote list: ${listing.map((wt) => wt.branch)}`);
  assert.equal(peerRow.path, peerPath);
  assert.ok(listing.every((wt) => wt.device.name === "Studio Mac"));
  // The peer's primary checkout is listed (a mirror of it lands on
  // mirror/<branch> here), and a bring of it is refused by name.
  const primaryRow = listing.find((wt) => wt.isPrimary);
  assert.ok(primaryRow, "the remote list names the peer's primary checkout");
  assert.equal(primaryRow.branch, "main");
  assert.deepEqual(await remoteList("--from", "Studio Mac"), listing);
  await refused(
    ["worktrees", "bring", primaryRow.name, "-p", "target"],
    "no-worktree",
    /primary checkout, which can be mirrored but not brought/,
  );
  // The away machine: said on stderr beside the list, and a refusal
  // when it is the one asked for.
  const withAway = await sm("worktrees", "list", "--remote", "-p", "target");
  assert.match(withAway.stderrTail, /"Studio Laptop" is not connected/);
  await refused(
    ["worktrees", "list", "--from", "Studio Laptop", "-p", "target"],
    "device-blocked",
    /not connected/,
  );
  const bare = await runCli(["worktrees", "bring", "-p", "target"]);
  assert.equal(bare.code, 2, "bring with no worktree is a usage error");
  assert.match(refusalDoc(finalDoc(bare)).error, /worktrees list --remote/);
  await refused(
    ["worktrees", "bring", "no-such-branch", "-p", "target"],
    "no-worktree",
    /No worktree "no-such-branch"/,
  );
  // The fixture worktree was made by plain git, outside the managed
  // layout, and the peer won't shelve an external worktree. The
  // bring still stands: it lands, exits 3, and says what didn't hold.
  const caveated = await runCli([
    "worktrees",
    "bring",
    "feat-peer",
    "-p",
    "target",
    "--source",
    "shelve",
  ]);
  assert.equal(caveated.code, 3, "a landed bring with a caveat exits 3");
  const brought = transferDoc(caveated);
  assert.equal(brought.ok, true);
  assert.equal(brought.worktree.projectId, targetProjectId);
  assert.equal(brought.captured, true);
  assert.equal(brought.dirtyApplied, true);
  assert.equal(brought.source?.done, false);
  assert.match(
    brought.caveats[0] ?? "",
    /the source was not shelved: External/,
  );
  assert.equal(
    readFileSync(join(brought.worktree.path, "peer-draft.txt"), "utf8"),
    "peer uncommitted\n",
  );
  // A managed worktree on the peer, which it will shelve.
  const managed = finalDoc(
    await sm(
      "create",
      "-p",
      "source",
      "--no-setup",
      "--no-cd",
      "-b",
      "feat-managed",
      "--",
      "wt-managed",
    ),
  );
  assert.equal(managed?.ok ?? true, true);
  const shelved = transferDoc(
    await sm(
      "worktrees",
      "bring",
      "wt-managed",
      "-p",
      "target",
      "--from",
      "Studio Mac",
      "--source",
      "shelve",
    ),
  );
  assert.deepEqual(shelved.source, { fate: "shelve", done: true });
  assert.deepEqual(shelved.caveats, []);
  const peerList = await buildClient(worktreesContract, peerA.transport).list({
    projectId: sourceProjectId,
  });
  assert.equal(
    peerList.find((wt) => wt.name === "wt-managed")?.shelved,
    true,
    "the source was shelved over the wire",
  );
  assert.equal(
    peerList.find((wt) => wt.id === worktreeIdFromPath(peerPath))?.shelved,
    false,
  );
});

it("mirror: sends the worktree and opens a session whose copy is the peer's, a repeat answers with the running one, and unmirror is refused until synced, then removes only the copy", async () => {
  peerOwns = targetProjectId;

  // ---- (7) mirror / mirrors / unmirror, against the recording engine.
  const mirrored = transferDoc(
    await sm("worktrees", "mirror", "wt-mirror", "-p", "source"),
  );
  assert.equal(mirrored.device.name, "Studio Mac");
  assert.ok(typeof mirrored.session === "string");
  // The transplants above each ran the engine once for their ignored
  // files (host/mirror/oneShot.ts), under the transfer label.
  mirrorsCreated = () =>
    engine.state.created.filter((input) => !isTransferSession(input));
  const created = only(mirrorsCreated());
  assert.ok(created !== undefined, "exactly one mirror session is created");
  assert.equal(
    created.localRoot,
    mirrorPath,
    "the session runs on the original",
  );
  assert.equal(created.remoteRoot, mirrored.worktree.path);
  assert.equal(created.labels[MIRROR_LABEL_MODE], "mirror");
  assert.equal(existsSync(join(mirrored.worktree.path, "m.txt")), true);

  const again = transferDoc(
    await sm("worktrees", "mirror", "wt-mirror", "-p", "source"),
  );
  assert.equal(again.alreadyMirrored, true);
  assert.equal(again.session, mirrored.session);
  assert.equal(mirrored.copySide, "remote");
  assert.equal(again.copySide, "remote");
  assert.equal(mirrorsCreated().length, 1, "no second session is opened");

  const running = mirrorsDoc(await sm("worktrees", "mirrors"));
  const listed = only(running.mirrors);
  assert.ok(listed !== undefined, "exactly one mirror is running");
  assert.equal(listed.copySide, "remote");
  assert.equal(listed.device.name, "Studio Mac");
  assert.equal(listed.localRoot, mirrorPath);

  await refused(
    ["worktrees", "unmirror", "wt-mirror", "-p", "source"],
    "stop-unconfirmed",
    /pass -f to stop anyway/,
  );
  assert.equal(
    engine.state.terminated.includes(mirrored.session),
    false,
    "a refused stop ends nothing",
  );
  engine.state.git = "synced";
  const stopped = stopDoc(
    await sm("worktrees", "unmirror", "wt-mirror", "-p", "source"),
  );
  assert.equal(stopped.mirror.copySide, "remote");
  assert.equal(engine.state.terminated.includes(mirrored.session), true);
  assert.equal(
    existsSync(mirrored.worktree.path),
    false,
    "stopping removes the copy on the peer",
  );
  assert.equal(existsSync(mirrorPath), true, "and never the original");
  assert.deepEqual(
    removalsOf(mirrored.worktree.id).map((entry) => entry.state),
    ["removing", "removed"],
    "the peer announces the copy's removal, and that it is gone",
  );
  await refused(
    ["worktrees", "unmirror", "wt-mirror", "-p", "source"],
    "no-mirror",
  );
});

it("unmirror of a mirror whose copy was already deleted on the peer ends the session unforced", async () => {
  // ---- (7a) A copy deleted on the peer outside a stop: the pair can
  // no longer read as synced, but the peer answers without the copy,
  // so the unforced unmirror ends the session with nothing to remove.
  engine.state.git = "following";
  const gone = transferDoc(
    await sm("worktrees", "mirror", "wt-mirror", "-p", "source"),
  );
  const removed = await buildClient(worktreesContract, peerA.transport).delete({
    projectId: gone.worktree.projectId,
    worktreeId: gone.worktree.id,
    force: true,
  });
  assert.ok(typeof gone.session === "string");
  assert.equal(removed.ok, true);
  assert.equal(existsSync(gone.worktree.path), false);
  stopDoc(await sm("worktrees", "unmirror", "wt-mirror", "-p", "source"));
  assert.equal(engine.state.terminated.includes(gone.session), true);
  assert.equal(existsSync(mirrorPath), true, "the original stays");
});

it("mirror --from: run by the peer on the original with its progress relayed, the copy local and the mirror invited past this device's switch (an ask that fails to land withdraws its invitation), a repeat from either end answers with that copy, --to with --from and a blank --from are refused as usage, and unmirror removes the local copy only", async () => {
  // ---- (7b) mirror --from: the peer holds the original, so the peer
  // runs the mirror (its mirror:startTo, on its own engine) and sends
  // the copy HERE, which lands through the ask's invitation. unmirror
  // removes the local copy through the peer and leaves the peer's
  // original.
  peerOwns = sourceProjectId;
  const usageBoth = await runCli([
    "worktrees",
    "mirror",
    "feat-in",
    "-p",
    "target",
    "--to",
    "A",
    "--from",
    "A",
  ]);
  assert.equal(usageBoth.code, 2, "--to with --from is a usage error");
  // An unset shell variable must not turn the bring into a send.
  const blankFrom = await runCli([
    "worktrees",
    "mirror",
    "feat-in",
    "-p",
    "target",
    "--from",
    "",
  ]);
  assert.equal(blankFrom.code, 2, "a blank --from is a usage error");
  // This device's own switch is not in the way: the ask invites the
  // mirror (host/mirror/invites.ts), and the invitation is what the
  // peer's send lands through. Nothing is invited before the ask,
  // and an ask the peer cannot land (the branch is taken here)
  // leaves none behind either.
  assert.deepEqual(listMirrorInvites(), [], "no invitation before the ask");
  await git(targetRepo, ["branch", "feat-in"]);
  const collided = await runCli([
    "worktrees",
    "mirror",
    "feat-in",
    "-p",
    "target",
    "--from",
    "Studio Mac",
  ]);
  assert.notEqual(collided.code, 0, "a landing on a taken branch is refused");
  assert.equal(engineA.state.created.length, 0, "the peer started nothing");
  assert.deepEqual(
    listMirrorInvites(),
    [],
    "a failed ask withdraws its invitation",
  );
  await git(targetRepo, ["branch", "-D", "feat-in"]);
  const createdHereBefore = mirrorsCreated().length;
  const inboundRun = await sm(
    "worktrees",
    "mirror",
    "feat-in",
    "-p",
    "target",
    "--from",
    "Studio Mac",
  );
  const inbound = transferDoc(inboundRun);
  assert.equal(inbound.worktree.projectId, targetProjectId);
  assert.equal(inbound.copySide, "local");
  assert.ok(typeof inbound.session === "string");
  assert.equal(
    mirrorsCreated().length,
    createdHereBefore,
    "the session runs on the peer, not here",
  );
  const inboundInput = engineA.state.created.at(-1);
  assert.ok(inboundInput);
  assert.equal(inboundInput.localRoot, inPath, "on the original");
  assert.equal(inboundInput.deviceId, "B");
  assert.equal(inboundInput.remoteRoot, inbound.worktree.path);
  assert.equal(inboundInput.labels[MIRROR_LABEL_MODE], "mirror");
  // The ask's invitation, for the peer and its original. It stays
  // pending here: the landing runs on the one listener both devices
  // share, stamped with the ASKING device as its caller, so it never
  // matches. What the landing does with it is mirror-invites.mts's.
  assert.deepEqual(
    listMirrorInvites().map(({ peerDeviceId, sourceWorktreeId }) => ({
      peerDeviceId,
      sourceWorktreeId,
    })),
    [{ peerDeviceId: "A", sourceWorktreeId: inboundInput.localWorktreeId }],
    "the ask left an invitation for the peer's original",
  );
  const inboundSteps = new Set(progressOf(inboundRun).map((doc) => doc.step));
  for (const step of ["capture", "create", "apply"]) {
    assert.ok(
      inboundSteps.has(step),
      `the peer's progress never relayed the ${step} step`,
    );
  }
  const inboundRow = mirrorsDoc(await sm("worktrees", "mirrors")).mirrors.find(
    (mirror) => mirror.session === inbound.session,
  );
  assert.ok(inboundRow);
  assert.equal(inboundRow.copySide, "local");
  assert.equal(inboundRow.device.name, "Studio Mac");
  // Asked again from either end, the answer is the running mirror
  // and the copy that is HERE, never a second start.
  const sessionsBefore = engineA.state.created.length;
  const repeats = await Promise.all(
    [
      ["feat-in", "-p", "target", "--from", "Studio Mac"],
      [inbound.worktree.path],
    ].map((repeat) => sm("worktrees", "mirror", ...repeat)),
  );
  for (const asked of repeats.map(transferDoc)) {
    assert.equal(asked.alreadyMirrored, true);
    assert.equal(asked.session, inbound.session);
    assert.equal(asked.copySide, "local");
    assert.equal(asked.worktree.path, inbound.worktree.path);
  }
  assert.equal(engineA.state.created.length, sessionsBefore);
  const inboundStop = stopDoc(
    await sm("worktrees", "unmirror", inbound.worktree.path),
  );
  assert.equal(inboundStop.mirror.copySide, "local");
  assert.equal(
    existsSync(inbound.worktree.path),
    false,
    "stopping removes the copy here",
  );
  assert.equal(existsSync(inPath), true, "and never the peer's original");
  const inboundRemovals = removalsOf(inbound.worktree.id);
  assert.deepEqual(
    inboundRemovals.map((entry) => entry.state),
    ["removing", "removed"],
    "the local copy's removal is announced, and that it is gone",
  );
  const [removing] = inboundRemovals;
  assert.ok(removing !== undefined, "the removal is announced");
  assert.equal(removing.projectId, targetProjectId);
  assert.ok(
    removing.endedThen.includes(inbound.session),
    "announced after the session ended: the delete follows the terminate",
  );
});

it("mirror --from of the peer's primary: lands as a worktree on mirror/main in mirror-<name>, labelled for the follower, and unmirror removes the copy with the peer's primary untouched", async () => {
  // ---- (7c) mirror --from of the peer's primary checkout: the copy
  // lands as a worktree on mirror/main in a mirror- folder, the
  // session is labelled for the follower, and the peer's primary
  // stays. Named by its folder, as list --remote shows it.
  const primaryMainBefore = await gitOut(sourceRepo, "rev-parse", "HEAD");
  const fromPrimary = transferDoc(
    await sm(
      "worktrees",
      "mirror",
      "source",
      "-p",
      "target",
      "--from",
      "Studio Mac",
    ),
  );
  assert.equal(fromPrimary.worktree.projectId, targetProjectId);
  assert.equal(fromPrimary.worktree.branch, "mirror/main");
  assert.equal(fromPrimary.worktree.name, "mirror-source");
  assert.equal(fromPrimary.worktree.isPrimary, false);
  assert.equal(fromPrimary.copySide, "local");
  const fromPrimaryInput = engineA.state.created.at(-1);
  assert.ok(fromPrimaryInput);
  assert.equal(fromPrimaryInput.localRoot, sourceRepo);
  assert.equal(fromPrimaryInput.remoteRoot, fromPrimary.worktree.path);
  assert.equal(fromPrimaryInput.labels[MIRROR_LABEL_MODE], "mirror-branch");
  assert.equal(
    await gitOut(fromPrimary.worktree.path, "rev-parse", "HEAD"),
    primaryMainBefore,
  );
  const fromPrimaryStop = stopDoc(
    await sm("worktrees", "unmirror", fromPrimary.worktree.path),
  );
  assert.equal(fromPrimaryStop.mirror.copySide, "local");
  assert.equal(existsSync(fromPrimary.worktree.path), false);
  assert.equal(
    await gitOut(sourceRepo, "rev-parse", "HEAD"),
    primaryMainBefore,
  );
  assert.equal(
    await gitOut(sourceRepo, "symbolic-ref", "HEAD"),
    "refs/heads/main",
    "the peer's primary must stay on its branch",
  );
  peerOwns = targetProjectId;
});

it("send to a peer with no checkout: devices says it takes a send, a bring from it is refused, and the send clones the repo in the default place first and lands the copy there", async () => {
  // ---- (7d) A peer with no checkout of the repo takes a send: it
  // clones the repo first, where the dialogs would, and the copy
  // lands in the clone, while a bring from it is refused. The sending
  // side needs a registry of its own, where the lone repo is
  // registered and the peer's (the shared one) has never seen it: a
  // second data dir behind a second control server, whose ops each
  // run on a second engine (asOther).
  // The peer answers on the direct wire, outside that context.
  const otherDataDir = join(sandbox, "data-other");
  mkdirSync(otherDataDir);
  const otherCli = createCliRunner(fixture.smBinary, {
    ...fixture.smEnv,
    SHIGOMORI_DATA_DIR: otherDataDir,
  });
  const otherEngine = await secondEngine(otherDataDir);
  const otherContext = await otherEngine.context();
  // A handler's effect runs on the second engine.
  const asOther =
    <I, A, E>(
      run: (input: I, ctx: HandlerContext) => Effect.Effect<A, E, HostServices>,
    ) =>
    (input: I, ctx: HandlerContext) =>
      Effect.provide(run(input, ctx), otherContext);
  // A transfer, the same way, as the effect its stream follows.
  const asOtherTransfer =
    <I, A>(
      run: (
        input: I,
        ctx: HandlerContext,
      ) => Effect.Effect<A, unknown, HostServices>,
    ) =>
    (input: I, ctx: HandlerContext) =>
      Effect.provide(run(input, ctx), otherContext);
  const otherControl = await startLoopback({
    file: join(otherDataDir, Loopback.LOOPBACK_FILE),
    handlers: {
      devices: asOther(controlHandlers.devices),
      peerWorktrees: asOther(controlHandlers.peerWorktrees),
      mirrors: asOther(controlHandlers.mirrors),
      mirrorStop: asOther(controlHandlers.mirrorStop),
    },
    transfers: {
      send: followTransfer(asOtherTransfer(send)),
      bring: followTransfer(asOtherTransfer(bring)),
    },
    run: otherEngine.runPromise as <A, E>(
      effect: Effect.Effect<A, E, never>,
    ) => Promise<A>,
  });
  track(otherControl.stop);
  // Deep in the sandbox, outside the home folder: the default place
  // is then where the peer keeps its repos (the sandbox, beside its
  // two), under the repo's own folder name.
  const loneRepo = join(sandbox, "lone", "src", "lone-repo");
  mkdirSync(join(sandbox, "lone", "src"), { recursive: true });
  await git(join(sandbox, "lone", "src"), [
    "init",
    "-q",
    "-b",
    "main",
    "lone-repo",
  ]);
  await fixture.disableAutoGc(loneRepo);
  await fixture.commitFile(loneRepo, "root.txt", "root\n", "root");
  const loneWtPath = await addWorktree(
    loneRepo,
    "lone-wt",
    "lone-feature",
    "lone.txt",
  );
  writeFileSync(join(loneWtPath, "lone-draft.txt"), "lone draft\n");
  await otherCli.sm("projects", "add", "--", loneRepo);
  const otherDoc = async (args: string[]) =>
    finalDoc(await otherCli.runCli(args));
  const loneDevices = decodeDevicesDoc(
    await otherDoc(["devices", "-p", "lone-repo"]),
  );
  assert.equal(
    loneDevices.devices.find((device) => device.name === "Studio Mac")?.block,
    "no-project",
  );
  const noBring = refusalDoc(
    await otherDoc([
      "worktrees",
      "bring",
      "lone-feature",
      "-p",
      "lone-repo",
      "--from",
      "Studio Mac",
    ]),
  );
  assert.equal(noBring.code, "device-blocked", noBring.error);
  assert.match(noBring.error, /has no checkout of this repo/);
  const cloneRun = await otherCli.runCli([
    "worktrees",
    "send",
    "lone-wt",
    "-p",
    "lone-repo",
    "--to",
    "Studio Mac",
  ]);
  assert.equal(
    cloneRun.code,
    0,
    cliFailureMessage(cloneRun, "the send failed"),
  );
  const cloneSent = transferDoc(cloneRun);
  assert.equal(cloneSent.cloned?.path, join(sandbox, "lone-repo"));
  assert.equal(cloneSent.worktree.projectId, cloneSent.cloned?.id);
  assert.equal(cloneSent.worktree.branch, "lone-feature");
  assert.equal(
    readFileSync(join(cloneSent.worktree.path, "lone-draft.txt"), "utf8"),
    "lone draft\n",
    "the uncommitted work landed in the clone's worktree",
  );
  assert.ok(
    progressOf(cloneRun).some((doc) => doc.step === "clone"),
    "the clone step was never reported",
  );
  await otherEngine.close();
});

it("a peer with no session is reported offline", async () => {
  // ---- (8) The peer going away mid-life reads as offline, not as a hang.
  connected = [];
  await refused(
    ["worktrees", "send", "wt-mirror", "-p", "source"],
    "device-blocked",
    /not connected/,
  );
});

it("a loopback.json removed under the running app is republished", async () => {
  // ---- (9) A data wipe takes loopback.json with the rest of the data
  // dir while the app lives on. The wipe's last step puts it back.
  rmSync(loopbackFile);
  await Effect.runPromise(control.loopback.publish);
  assert.deepEqual(JSON.parse(readFileSync(loopbackFile, "utf8")), published);
  finalDoc(await sm("worktrees", "mirrors"));
});

it("stopping the loopback unpublishes it", async () => {
  // ---- (10) Stop unpublishes, and the CLI reads that as not running.
  await control.stop();
  assert.equal(existsSync(loopbackFile), false, "stop removes loopback.json");
  await refused(["worktrees", "mirrors"], "app-not-running");
});
