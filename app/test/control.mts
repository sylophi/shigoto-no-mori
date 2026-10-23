// Durable proof that `sm worktrees unmirror` removes the mirror's own
// copy and nothing else, end to end: the REAL sm binary (built from
// packages/cli by this check) finds the REAL loopback
// (host/socket/Loopback.ts) through loopback.json in a sandboxed data
// dir, proves the token in the link's handshake, and the loopback
// serves the REAL control handlers (host/ipc/modules/control.ts),
// which run the REAL mirror orchestrators (mirror:startTo,
// mirror:startFrom, mirror:stop) over a REAL direct websocket to the
// listener, which run the engine for every git step against real
// fixture repos.
// The account's device registry is the one double (it is an HTTP read
// of the hub), and the mirror engine is a recording stand-in: its real
// runs are test/mirror.mts's, while what is pinned here is what the
// control layer asks of it. Asserts:
//   - `mirror` sends the worktree to the peer, and `unmirror` is
//     refused until the follower reports synced (stop-unconfirmed),
//     ending nothing, then ends the session and removes the peer's
//     copy, never the original.
//   - `mirror --from` of the peer's primary checkout lands the copy
//     here as a worktree of its own, and `unmirror` removes it with
//     the peer's primary left on its branch at its commit.
//
// Every worktree is named with -p: a landed copy keeps its source's
// folder name, and with both projects in one registry the bare name
// would be ambiguous.
//
// Both "devices" share one node process and one sandboxed data dir
// holding two projects (source and target, one repo identity), as in
// test/sync-transfer.mts: what separates them is the direct wire.
// Run: pnpm test control.
import { LOOPBACK_FILE } from "@shigomori/engine/Control";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import {
  ControlTransferResultSchema,
  controlContract,
} from "@shigomori/contracts/modules/control";
import {
  mirrorContract,
  type MirrorGitStatus,
  type MirrorSessionRaw,
} from "@shigomori/contracts/modules/mirror";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { hostContext, runHost } from "./lib/hostRuntime.mts";
import type { HostServices } from "@host/process/services";
import type { ClientTransport, HandlerContext } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { loose } from "@shigomori/contracts/schemas/loose";
import { strict } from "@shigomori/contracts/schemas/strict";
import { controlHandlers, controlTransfers } from "@host/ipc/modules/control";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { MirrorEngine } from "@host/mirror/MirrorEngine";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import * as HostAccount from "@host/lib/HostAccount";
import * as Loopback from "@host/socket/Loopback";
import type { LinkRegistrar } from "@host/socket/DeviceLink";
import { createServed } from "@shared/ipc/served";
import * as Views from "@host/lib/Views";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { type CliResult, makeTracker } from "./lib/checkKit.mts";
import { afterAll, beforeAll, it } from "vitest";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { bootDirectWire, DIALER, LISTENER } from "./lib/directBoot.mts";
import { inertMirrorImpl, rawMirrorSession } from "./lib/mirrorFakes.mts";
import {
  pushesLayer,
  standInAccount,
  standInDeviceId,
  standInMirror,
  standInPeers,
} from "./lib/hostStandIns.mts";

const fixture = cliSandbox("sm-control-check-");
const { dataDir, gitOut, runCli, sm } = fixture;
const { addWorktree, projectIdOf } = fixture;
const loopbackFile = join(dataDir, LOOPBACK_FILE);

// The REAL loopback on loopbackFile, serving the control contract's
// handlers and transfers over the proof file's host services. Answers
// its stop.
async function startLoopback() {
  const registrar: LinkRegistrar = createServed();
  registrar.serve(controlContract, controlHandlers);
  registrar.view(controlContract, controlTransfers);
  const host = await hostContext();
  const scope = Scope.makeUnsafe();
  await runHost(
    Layer.buildWithScope(
      Layer.unwrap(
        Effect.map(Effect.context<HostServices>(), (services) =>
          Loopback.layer({
            registrar,
            deviceId: () => DIALER,
            appVersion: "9.9.9",
            file: () => loopbackFile,
            services: Effect.succeed(services),
          }),
        ),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(StoreChanges.layer, pushesLayer, Views.layer).pipe(
            Layer.provideMerge(Layer.succeedContext(host)),
          ),
        ),
      ),
      scope,
    ),
  );
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}

// The final {ok} document of a run.
const finalDoc = (result: CliResult) =>
  result.docs.findLast((doc) => typeof doc.ok === "boolean");

// A finished transfer's {ok: true} document is the control op's own
// answer with the CLI's ok and its caveats on top.
const TransferDocSchema = strict(
  Schema.Struct({
    ...ControlTransferResultSchema.struct.fields,
    ok: Schema.Literal(true),
    caveats: Schema.Array(Schema.String),
  }),
);
// A refused run's {ok: false} document.
const RefusalDocSchema = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.optional(Schema.String),
  error: Schema.String,
});
const decodeTransferDoc = Schema.decodeUnknownSync(TransferDocSchema);
const transferDoc = (result: CliResult) => decodeTransferDoc(finalDoc(result));
const refusalDoc = Schema.decodeUnknownSync(RefusalDocSchema);
const looseRows = Schema.decodeUnknownSync(
  Schema.Array(loose(Schema.Struct({ id: Schema.String }))),
);

async function refused(args: string[], code: string) {
  const result = await runCli(args);
  assert.equal(result.code, 1, `sm ${args.join(" ")} should exit 1`);
  const doc = refusalDoc(finalDoc(result));
  assert.equal(doc.code, code, `sm ${args.join(" ")}: ${doc.error}`);
}

// One row of the account's device registry, as the hub lists it.
const registered = (deviceId: string, name: string): DeviceInfo => ({
  deviceId,
  name,
  platform: "darwin",
  icon: "laptop",
  createdAt: 1,
  lastSeenAt: null,
  online: true,
});

// This device reported signed in with "Allow control from other
// devices" on, which a peer's "Mirror here" lands through.
const allowControl = () =>
  runHost(
    Effect.flatMap(HostAccount.HostAccount, (account) =>
      account.set({
        hubUrl: "http://127.0.0.1:9",
        accountId: "account",
        credential: "",
        deviceKey: "",
        webOrigin: "",
        acceptsCommands: true,
      }),
    ),
  );

// The mirror engine's stand-in: reports the sessions it was asked to
// create and records the ones it was asked to end. `git` is the
// follower's verdict the stop guard reads.
function fakeMirrorEngine() {
  const sessions = new Map<string, MirrorSessionRaw>();
  const state: {
    terminated: string[];
    git: MirrorGitStatus["status"];
  } = { terminated: [], git: "following" };
  let next = 0;
  const impl = inertMirrorImpl({
    sessions: Effect.sync(() => [...sessions.values()]),
    create: (input) =>
      Effect.sync(() => {
        next += 1;
        const session = `sync_fake${next}`;
        sessions.set(
          session,
          rawMirrorSession({
            session,
            name: input.name,
            labels: input.labels,
            localWorktreeId: input.localWorktreeId,
            localRoot: input.localRoot,
            deviceId: input.deviceId,
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            remoteRoot: input.remoteRoot,
            ignores: [...input.ignores],
            createdAt: Date.now(),
            statusText: "Watching for changes",
            successfulCycles: 1,
          }),
        );
        return session;
      }),
    terminate: (session) =>
      Effect.sync(() => {
        state.terminated.push(session);
        sessions.delete(session);
      }),
    gitStatus: () => ({ status: state.git, detail: "" }),
    refreshGit: () => Effect.succeed({ status: state.git, detail: "" }),
  });
  return { state, impl };
}

const { track, teardown } = makeTracker();
afterAll(async () => {
  await teardown();
  await fixture.remove();
});

let sourceRepo: string;
let mirrorPath: string;
let targetProjectId: string;
let sourceProjectId: string;
let engine: ReturnType<typeof fakeMirrorEngine>;
let peerOwns: string;

beforeAll(async () => {
  await fixture.buildSm();

  // Source repo (this device, the dialer) and its clone (the peer, the
  // listener), one repo identity between them.
  sourceRepo = await fixture.initRepo("source");
  await fixture.commitFile(sourceRepo, "readme.txt", "base\n", "base");
  const targetRepo = await fixture.cloneRepo(sourceRepo, "target");
  mirrorPath = await addWorktree(
    sourceRepo,
    "wt-mirror",
    "feat-mirror",
    "m.txt",
  );

  await fixture.useCli();
  // Target first: the peer's identity scan takes the first registry
  // match, which must be the peer's own checkout.
  targetProjectId = await projectIdOf(targetRepo);
  sourceProjectId = await projectIdOf(sourceRepo);

  // Each device's mirror engine. The peer runs the mirrors whose
  // original it holds (mirror --from), on its own engine, which its
  // handlers run on, and its follower reads as synced.
  engine = fakeMirrorEngine();
  const listenerEngine = fakeMirrorEngine();
  listenerEngine.state.git = "synced";
  standInMirror(engine.impl);
  const onListener =
    <I, A, E, R>(
      run: (input: I, ctx: HandlerContext) => Effect.Effect<A, E, R>,
    ) =>
    (input: I, ctx: HandlerContext) =>
      run(input, ctx).pipe(
        Effect.provideService(MirrorEngine, listenerEngine.impl),
      );
  const listenerMirror: EffectHandlers<
    typeof mirrorContract,
    HandlerContext,
    HostServices
  > = {
    list: onListener(mirrorHandlers.list),
    startTo: onListener(mirrorHandlers.startTo),
    startFrom: onListener(mirrorHandlers.startFrom),
    stop: onListener(mirrorHandlers.stop),
    pause: onListener(mirrorHandlers.pause),
    resume: onListener(mirrorHandlers.resume),
    setIgnores: onListener(mirrorHandlers.setIgnores),
    history: onListener(mirrorHandlers.history),
    // The stream is served apart from the engine slot.
    openStream: mirrorHandlers.openStream,
    gitState: onListener(mirrorHandlers.gitState),
    applyGitState: onListener(mirrorHandlers.applyGitState),
  };
  const { listener, toListener } = await bootDirectWire(track, {
    contracts: [
      [syncContract, syncHandlers],
      [worktreesContract, worktreesHandlers],
      [projectsContract, projectsHandlers],
      [mirrorContract, listenerMirror],
      [worktreeDataContract, worktreeDataHandlers],
    ],
  });
  listener.setAccepts(true);
  // The account as the hub would list it: this device and the peer.
  const registry = [
    registered(DIALER, "Agent Box"),
    registered(LISTENER, "Studio Mac"),
  ];
  // Which of the two projects the peer answers as its checkout of
  // the repo. Both devices read one registry here, so the peer's
  // projects:list holds both: a mirror's copy lands in the target (the
  // peer's own identity scan), and for a mirror --from the roles swap,
  // the peer's original living in the source and its copy landing in
  // the target.
  peerOwns = targetProjectId;
  const peerTransport: ClientTransport = {
    ...toListener.transport,
    invoke: async (channel, input) => {
      const result = await toListener.transport.invoke(channel, input);
      return channel === "projects:list"
        ? // Loose: the host under test gets the peer's rows as sent.
          looseRows(result).toSorted(
            (a, b) => Number(b.id === peerOwns) - Number(a.id === peerOwns),
          )
        : result;
    },
  };
  standInAccount({
    listDevices: Effect.succeed(registry),
    directPeers: Effect.sync(() => ({
      [LISTENER]: {
        acceptsCommands: listener.acceptsCommands(),
        sharesData: listener.sharesData(),
      },
    })),
  });
  // Every reach into the peer: its contracts, and the session's byte
  // channels, which a mirror's send rides.
  standInPeers({
    transportFor: () => peerTransport,
    channelsFor: () => toListener.channels,
  });
  standInDeviceId(DIALER);
  track(await startLoopback());
});

it("unmirror of a mirror run here is refused until the follower reports synced, then removes the peer's copy and never the original", async () => {
  // ---- (1) mirror, then unmirror, against the recording engine.
  const mirrored = transferDoc(
    await sm("worktrees", "mirror", "wt-mirror", "-p", "source"),
  );
  assert.ok(typeof mirrored.session === "string");
  assert.equal(existsSync(join(mirrored.worktree.path, "m.txt")), true);

  await refused(
    ["worktrees", "unmirror", "wt-mirror", "-p", "source"],
    "stop-unconfirmed",
  );
  assert.equal(
    engine.state.terminated.includes(mirrored.session),
    false,
    "a refused stop ends nothing",
  );
  engine.state.git = "synced";
  await sm("worktrees", "unmirror", "wt-mirror", "-p", "source");
  assert.equal(engine.state.terminated.includes(mirrored.session), true);
  assert.equal(
    existsSync(mirrored.worktree.path),
    false,
    "stopping removes the copy on the peer",
  );
  assert.equal(existsSync(mirrorPath), true, "and never the original");
});

it("unmirror of a mirror --from of the peer's primary removes the copy here and leaves the primary on its branch at its commit", async () => {
  // ---- (2) mirror --from of the peer's primary checkout: the peer
  // runs the mirror and the copy lands here, a worktree of its own.
  // Named by its folder, as list --remote shows it.
  peerOwns = sourceProjectId;
  await allowControl();
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
  assert.equal(
    fromPrimary.worktree.isPrimary,
    false,
    "the copy is a worktree, never this device's checkout",
  );
  assert.equal(
    await gitOut(fromPrimary.worktree.path, "rev-parse", "HEAD"),
    primaryMainBefore,
  );
  await sm("worktrees", "unmirror", fromPrimary.worktree.path);
  assert.equal(
    existsSync(fromPrimary.worktree.path),
    false,
    "stopping removes the copy here",
  );
  assert.equal(
    await gitOut(sourceRepo, "rev-parse", "HEAD"),
    primaryMainBefore,
  );
  assert.equal(
    await gitOut(sourceRepo, "symbolic-ref", "HEAD"),
    "refs/heads/main",
    "the peer's primary must stay on its branch",
  );
});
