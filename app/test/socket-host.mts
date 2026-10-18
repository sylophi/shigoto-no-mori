// Durable proof for the device link's listener (host/socket/DeviceLink.ts)
// and its dialer (shared/remote/deviceLink.ts): a real listener on an
// ephemeral loopback port (test/lib/directBoot.mts), dialed through the
// ticket handshake by the real dialer, asserting the calls, the pushes,
// the errors crossing as their classes, and the hardening: a refused
// ticket and the lockout behind it, the protocol version, calls before
// a hello, the hello timeout, the Origin gate, the frame cap, the
// in-flight cap, supersede (a desktop's second link) and a web device's
// several (one per tab), liveness and the listener stopping.
//
// The command gate (CommandGate): a call annotated gated:false runs for
// every linked peer, and any other only while the host accepts
// commands, refused with CommandRefusedError before its handler runs.
// The switch's one exception, a call the host invited
// (WsServerTicketAuth.isInvited), runs with the switch off, and the
// byte channel it attaches outlives the drop the switch-off deals every
// other channel.
//
// The sharing gate (SharingGate): with the host's sharing off, a peer's
// reads and commands alike are refused with NotSharingError before
// their handlers run, and its pushes are withheld, save for the mirror
// this device asked for, whose calls on its copy are still served and
// whose copy's pushes still arrive. Flipped while a peer is linked,
// its calls and views under way end, its byte channels drop, and it
// hears the switch both ways.
//
// Interruption: a call its caller cancels, or whose link drops, is
// interrupted on the host, its handler's signal aborted. Views stream
// their values, and end as a disconnect when this side closes their
// link. Tracing: the host's span for a call continues the caller's
// trace.
//
// The relay a window's host serves a peer's view through (hub:watchPeer,
// servedWatchPeer) holds a bounded backlog for a window that falls
// behind, then ends the view, and the flood with it. A link the host
// cuts writes nothing more to its socket once it is closing.
//
// What each call may do over the link, its annotations, is held whole
// in packages/contracts/fixtures/wire/classification.json
// (packages/contracts/README.md, "Classification"). Here, the registrar's
// rule over them: every call classifies itself, and the consent table
// names exactly the calls that name each line.
//
// Run: pnpm test socket-host.
//
// covers: app/host/process/wires.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Paths from "@shigomori/engine/Paths";
import { reconcileOnLastPort, rememberedPort } from "@host/direct/listenerPort";
import { mintHexId } from "@host/lib/hexId";
import { MAX_MESSAGE_BYTES } from "@host/socket/boundedMessages";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { WebSocket } from "ws";
import { it } from "vitest";
import {
  CommandRefusedError,
  LinkRefusedError,
  LinkUnauthenticatedError,
  NoDirectConnectionError,
  NotSharingError,
  ProtocolVersionMismatchError,
  RemoteCallError,
  UnknownProjectError,
} from "@shigomori/contracts/errors";
import {
  annotation,
  callOf,
  callsOf,
  channelOf,
  Grant,
  scopeOf,
} from "@shigomori/contracts/contract";
import { GRANTS } from "@shigomori/contracts/grants";
import { controlContract } from "@shigomori/contracts/modules/control";
import { guideDriveContract } from "@shigomori/contracts/modules/guide";
import { safeDecode } from "@shigomori/contracts/codec";
import { classificationGap } from "@shared/ipc/served";
import type { HandlerContext } from "@shared/ipc/transport";
import { allContractModules } from "@shigomori/contracts/allModules";
import { gitContract } from "@shigomori/contracts/modules/git";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import {
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/remote/deviceLink";
import {
  CLOSE_TRY_AGAIN,
  LINK_MAX_FRAME_BYTES,
  LinkGroup,
} from "@shigomori/contracts/link";
import {
  CLOSE_HANDSHAKE_FAILED,
  SEAL_OVERHEAD_BYTES,
  sealDialer,
} from "@shared/remote/sealedSocket";
import { generateKeyPair } from "@shared/crypto/noise";
import { MAX_IN_FLIGHT_PER_PEER } from "@shared/remote/link";
import {
  dropMirrorInvitesWithPeers,
  inviteMirror,
  landInvitedMirror,
  loadMirrorInvites,
  mirrorInviteAdmits,
  mirrorInviteSees,
} from "@host/mirror/invites";
import {
  makeHubHandlers,
  RELAY_BACKLOG,
  servedWatchPeer,
} from "@shared/hub/bridgeHandlers";
import { RemoteDisconnectedError } from "@shared/remote/rpcTransport";
import { runHost } from "./lib/hostRuntime.mts";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import type { ChannelHandle } from "@shigomori/contracts/link";
import {
  delay,
  sleepingClock,
  testClock,
  type Track,
  waitFor,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import {
  DIALER,
  type DialOpts,
  dialing,
  dialListener,
  type DirectListener,
  type DirectListenerOpts,
  LISTENER,
  mintTicket,
  startDirectListener,
} from "./lib/directBoot.mts";
import { testDeviceKey } from "./lib/hubStub.mts";

// What the test handlers saw.
type Seen = {
  refreshes: number;
  // The values a peer's endless flood has been pulled for.
  pulled: number;
  // What a call that leaves something going (a script's console) keeps
  // to reach its caller with.
  notifiers: HandlerContext["notifier"][];
  hanging: { signal: AbortSignal; resolve: (value: unknown) => void }[];
  channels: Map<
    string,
    { data: string[]; reset: boolean; handle: ChannelHandle | null }
  >;
};

// A flood's backlog: a client's 64 chunks of 256K characters each
// (host/lib/terminals/Terminals.ts), 16 MiB in all.
const FLOOD_CHUNKS = 64;
const FLOOD_CHUNK_CHARS = 256 * 1024;
// A flood a relay with no bound buffers whole: 64 MiB of chunks.
const ENDLESS_CHUNKS = 4096;
const ENDLESS_CHUNK_CHARS = 16 * 1024;

// Stand-ins for real handlers, on real contract calls: a read
// (git:sweep), a command (git:refreshProject, which also fails on cue
// and notifies its caller), a call that waits to be released
// (worktrees:list, a read) and a byte-stream open (forward:open, a
// command).
function serve(listener: DirectListener, seen: Seen): void {
  const { binding } = listener;
  binding.handle("git:sweep", async () => ({ leaseMs: 5 }));
  binding.handle("git:refreshProject", async (ctx, input) => {
    seen.refreshes += 1;
    const { projectId } = input as { projectId: string };
    if (projectId === "gone") throw new UnknownProjectError({ projectId });
    if (projectId === "plain") {
      throw Object.assign(new Error("boom"), { code: "EBOOM" });
    }
    if (projectId === "notify") {
      ctx.notifier(gitContract, "projectChanged")({ projectId: "mine" });
    }
    if (projectId === "keep") seen.notifiers.push(ctx.notifier);
  });
  binding.handle("worktrees:list", (ctx) => hang(seen, ctx));
  // A view: what the projects list reads as, twice.
  binding.view("projects:watch", () => Stream.make([], []));
  // A view that never ends, as a live one doesn't.
  binding.view("ports:watch", () => Stream.never);
  // A terminal's output as a client that fell behind a flood is handed
  // it: its whole backlog at once, the most a chunk holds each. Or one
  // event past what the dialer's decoder takes.
  // Or a flood that goes on for as long as it is read, counting what it
  // was read for.
  binding.view("terminals:attach", (input) =>
    (input as { terminalId: string }).terminalId === "huge"
      ? Stream.make({
          kind: "output",
          data: "y".repeat(LINK_MAX_FRAME_BYTES + (1 << 20)),
          seq: 1,
        })
      : (input as { terminalId: string }).terminalId === "endless"
        ? Stream.fromEffectRepeat(
            Effect.sync(() => ({
              kind: "output",
              data: "y".repeat(ENDLESS_CHUNK_CHARS),
              seq: ++seen.pulled,
            })),
          ).pipe(Stream.take(ENDLESS_CHUNKS))
        : Stream.fromIterable(
            Array.from({ length: FLOOD_CHUNKS }, (_, n) => ({
              kind: "output",
              data: "y".repeat(FLOOD_CHUNK_CHARS),
              seq: n + 1,
            })),
          ),
  );
  binding.handle("forward:open", async (ctx, input) => {
    const { channelId } = input as { channelId: string };
    const record = {
      data: [] as string[],
      reset: false,
      handle: null as ChannelHandle | null,
    };
    const channels = ctx.channels;
    assert.ok(channels !== undefined, "the link carries no channels");
    record.handle = channels.attach(channelId, {
      onData: (data, consumed) => {
        record.data.push(Buffer.from(data).toString());
        // Echoed back, so the dialer reads what it wrote.
        record.handle?.write(data);
        consumed();
      },
      onEnd: () => record.handle?.end(),
      onReset: () => {
        record.reset = true;
      },
      onWritable: () => {},
    });
    seen.channels.set(channelId, record);
  });
}

function hang(
  seen: Seen,
  ctx: HandlerContext & { readonly signal: AbortSignal },
): Promise<unknown> {
  return new Promise((resolve) => {
    seen.hanging.push({ signal: ctx.signal, resolve });
  });
}

async function listen(
  track: Track,
  opts: DirectListenerOpts = {},
): Promise<{ listener: DirectListener; seen: Seen }> {
  const seen: Seen = {
    refreshes: 0,
    pulled: 0,
    notifiers: [],
    hanging: [],
    channels: new Map(),
  };
  const listener = await startDirectListener(track, {
    ...opts,
    registerHandlers: (binding) => {
      serve({ binding } as DirectListener, seen);
      opts.registerHandlers?.(binding);
    },
  });
  return { listener, seen };
}

async function dialFails(
  listener: DirectListener,
  opts: DialOpts = {},
): Promise<RemoteConnectError> {
  const error = await dialing(listener, opts)
    .authenticate()
    .then(
      () => assert.fail("the dial linked"),
      (failure: unknown) => failure,
    );
  assert.ok(error instanceof RemoteConnectError, String(error));
  return error;
}

// The dial's socket sending these headers, as a browser or the
// tunnel's connector does.
const withHeaders = (headers: Record<string, string>) => (url: string) =>
  new WebSocket(url, { headers });

// The dial's socket, hearing the size of every frame it receives,
// sealed.
const hearingFrames = (onFrame: (bytes: number) => void) => (url: string) => {
  const ws = new WebSocket(url);
  ws.on("message", (data: Buffer) => onFrame(data.byteLength));
  return ws;
};

const invoke = (
  connection: DeviceConnection,
  channel: string,
  input?: unknown,
  signal?: AbortSignal,
) => connection.transport.invoke(channel, input, { signal });

// What a view on one worktree asks with.
const WORKTREE = { projectId: "p", worktreeId: "w" };

// The bridge a window's host serves hub:watchPeer from, its one peer
// session this link.
const bridgeOver = (connection: DeviceConnection) =>
  makeHubHandlers({
    status: () => ({
      socket: { phase: "connected", remoteDeviceId: "", remoteAppVersion: "" },
      onlineDeviceIds: [],
      peerAppVersions: {},
      peerAcceptsCommands: {},
      peerSharesData: {},
    }),
    connectDirect: async () => ({
      ...connection,
      acceptsCommands: true,
      sharesData: true,
    }),
  });

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("the call resolved"),
    (error: unknown) => error,
  );

// The link's RPC without the dialer: for what the dialer never does
// (a call before its hello, a hello on another version, a peer that
// never pings).
async function rawLink(
  track: Track,
  listener: DirectListener,
  opts: { pingInterval?: number; ticket?: string; deflate?: boolean } = {},
) {
  const scope = Scope.makeUnsafe();
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}`, {
    perMessageDeflate: opts.deflate ?? false,
  });
  const closed = new Promise<number>((resolve) =>
    ws.on("close", (code) => resolve(code)),
  );
  // Sealed like the dialer's, with a ticket minted for DIALER.
  // ws's socket is a WebSocketLike at runtime, as the dialer hands it over, but its event types differ
  const sealed = sealDialer(ws as Socket.WebSocketLike, {
    ticket: opts.ticket ?? mintTicket(listener.tickets, DIALER),
    localKey: testDeviceKey(DIALER).pair,
    remoteKey: testDeviceKey(LISTENER).pair.publicKey,
  });
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* Socket.fromWebSocket(Effect.succeed(sealed));
      const protocol = yield* RpcClient.makeProtocolSocket({
        pingInterval: opts.pingInterval ?? 5_000,
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerSchemaBinary()),
      );
      return yield* RpcClient.make(LinkGroup, { flatten: true }).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
    }).pipe(Scope.provide(scope)),
  );
  // oxlint-disable-next-line shigomori/no-double-cast -- the link's group types its calls only as Rpc.AnyWithProps
  const flat = client as unknown as (
    tag: string,
    payload: unknown,
  ) => Effect.Effect<unknown, unknown>;
  const call = (tag: string, payload?: unknown) => flat(tag, payload);
  const watch = (tag: string, payload?: unknown) =>
    // oxlint-disable-next-line shigomori/no-double-cast -- a streaming call answers a Stream, which the flat type above does not say
    flat(tag, payload) as unknown as Stream.Stream<unknown, unknown>;
  const hello = async (
    protocolVersion = PROTOCOL_VERSION,
    as: { deviceKind: "desktop" | "web"; connectionId: string } = {
      deviceKind: "desktop",
      connectionId: "c".repeat(32),
    },
  ) =>
    Effect.runPromiseExit(
      call("link:hello", {
        deviceId: DIALER,
        ...as,
        appVersion: "1.0.0",
        protocolVersion,
      }),
    );
  // Its handshake done, so the listener holds what the socket opened
  // with.
  await new Promise<void>((resolve) => {
    if (sealed.readyState === 1) resolve();
    else sealed.addEventListener("open", () => resolve(), { once: true });
  });
  // A frame as it is, past the RPC client: what a far end on another
  // layout would send.
  const send = (frame: Uint8Array<ArrayBuffer>) => sealed.send(frame);
  return { call, watch, hello, closed, send };
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isFailure(exit), "the call succeeded");
  return Cause.squash(exit.cause);
};

it("handshake: a proven ticket links, and the welcome names the host and proves the ticket", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const connection = await dialListener(track, listener);
  assert.equal(connection.remoteDeviceId, LISTENER);
  assert.equal(connection.remoteAppVersion, "2.0.0");
});

it("calls: a read answers with its result, and a failure crosses as its contract error, or as RemoteCallError with its message and code", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
  const gone = await rejection(
    invoke(connection, "git:refreshProject", { projectId: "gone" }),
  );
  assert.ok(gone instanceof UnknownProjectError);
  assert.equal(gone.projectId, "gone");
  const plain = await rejection(
    invoke(connection, "git:refreshProject", { projectId: "plain" }),
  );
  assert.ok(plain instanceof RemoteCallError);
  assert.equal(plain.message, "boom");
  assert.equal(plain.code, "EBOOM");
});

// A call that changes code runs only while no data-folder move can
// start: one is refused while a move holds the lock alone, and a read
// still answers.
it("calls: one that changes code is refused while a data-folder move holds the lock, and a read answers", async () => {
  const track = trackTest;
  const lockFile = await runHost(
    Effect.map(Paths.Paths, ({ pointerFile }) =>
      join(dirname(pointerFile), "data-dir.lock"),
    ),
  );
  mkdirSync(dirname(lockFile), { recursive: true });
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const move = new DatabaseSync(lockFile);
  move.exec("PRAGMA locking_mode = EXCLUSIVE");
  move.exec("CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY)");
  move.exec("INSERT OR REPLACE INTO held (id) VALUES (1)");
  try {
    const refused = await rejection(
      invoke(connection, "git:refreshProject", { projectId: "plain" }),
    );
    assert.match(String(refused), /The data folder is being moved/);
    assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
      leaseMs: 5,
    });
  } finally {
    move.close();
  }
});

const has = (pushes: unknown[], projectId: string) =>
  pushes.some(
    (push) => (push as { projectId: string }).projectId === projectId,
  );

it("pushes: a broadcast reaches every linked peer, and a handler's notifier only its caller", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const heard = { one: [] as unknown[], two: [] as unknown[] };
  const one = await dialListener(track, listener, { dialer: "one" });
  const two = await dialListener(track, listener, { dialer: "two" });
  one.transport.subscribe("git:projectChanged", (p) => heard.one.push(p));
  two.transport.subscribe("git:projectChanged", (p) => heard.two.push(p));
  // Each link subscribes as it opens: broadcast until both hear it.
  await waitFor(() => {
    listener.binding.broadcastAll("git:projectChanged", { projectId: "all" });
    return heard.one.length > 0 && heard.two.length > 0;
  }, "both peers to hear the broadcast");
  await invoke(one, "git:refreshProject", { projectId: "notify" });
  await waitFor(() => has(heard.one, "mine"), "the caller to hear its push");
  // A broadcast after it, as a fence: the other peer hears that, and
  // never the caller's push.
  listener.binding.broadcastAll("git:projectChanged", { projectId: "fence" });
  await waitFor(
    () => has(heard.two, "fence"),
    "the other peer to hear the fence",
  );
  assert.equal(has(heard.two, "mine"), false);
});

it("refusal: a ticket the host never minted is a blocked verdict, and five of them lock the address out, which a dialer backs off through", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  for (let attempt = 0; attempt < 5; attempt++) {
    const refused = await dialFails(listener, { ticket: "smpt_never_minted" });
    assert.equal(refused.blocked, true);
    assert.ok(refused.refusal instanceof LinkRefusedError);
  }
  const locked = await dialFails(listener);
  assert.equal(locked.blocked, false);
  assert.equal(locked.code, 4003);
});

it("lockout: an address is benched for 30 s of time awake, which neither a sleep nor a step of the wall clock either way spends", async () => {
  const track = trackTest;
  const clock = testClock();
  const { wall, sleep, stop } = sleepingClock(clock);
  const { listener } = await listen(track, {
    provide: Layer.succeed(Clock.Clock, wall),
  });
  const lockOut = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await dialFails(listener, { ticket: "smpt_never_minted" });
    }
  };
  const lockedOut = async (why: string) =>
    assert.equal((await dialFails(listener)).code, 4003, why);
  await lockOut();
  // A two-hour sleep: the wall clock ran on, monotonic time stood.
  sleep(2 * 3_600_000);
  await lockedOut("a sleep or a forward step ended the lockout");
  sleep(-4 * 3_600_000);
  await lockedOut("a backward step ended the lockout");
  // 30 s awake, the wall clock still two hours behind.
  await clock.advance(30_000);
  await dialListener(track, listener);
  // Stopped for 30 s: both clocks ran on.
  await lockOut();
  stop(30_000);
  await dialListener(track, listener);
});

it("lockout: tickets that lapsed (replaced by the connection's next ask, expired, or replaced between the handshake and the hello) are refused past the threshold and leave a correct dial from the same address accepted", async () => {
  const track = trackTest;
  let now = 0;
  const { listener } = await listen(track, {
    ticketOpts: { ttlMs: 60_000, now: () => now },
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const raw = await rawLink(track, listener);
    mintTicket(listener.tickets, DIALER);
    assert.ok(failureOf(await raw.hello()) instanceof LinkRefusedError);
    const replaced = mintTicket(listener.tickets, DIALER);
    mintTicket(listener.tickets, DIALER);
    assert.notEqual(
      (await dialFails(listener, { ticket: replaced })).code,
      4003,
    );
    const expired = mintTicket(listener.tickets, DIALER);
    now += 60_000;
    assert.notEqual(
      (await dialFails(listener, { ticket: expired })).code,
      4003,
    );
  }
  await dialListener(track, listener);
});

it("lockout: a device on another version, refused past the threshold, leaves a correct dial from the same address accepted", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  // A build before sealed links opens with a clear frame of its own.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${listener.port}`);
      ws.on("open", () => ws.send(Buffer.from("link:challenge, in the clear")));
      ws.on("close", (closed) => resolve(closed));
      ws.on("error", () => {});
    });
    assert.equal(code, CLOSE_HANDSHAKE_FAILED);
  }
  // A sealed build on another protocol version.
  for (let attempt = 0; attempt < 6; attempt++) {
    const refused = await dialFails(listener, {
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    assert.ok(refused.refusal instanceof ProtocolVersionMismatchError);
  }
  const connection = await dialListener(track, listener);
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
});

it("version: a hello on another protocol version is refused with ProtocolVersionMismatchError, a blocked verdict the dialer hands on", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const mismatched = await dialFails(listener, {
    protocolVersion: PROTOCOL_VERSION + 1,
  });
  assert.equal(mismatched.blocked, true);
  assert.ok(mismatched.refusal instanceof ProtocolVersionMismatchError);
  assert.equal(mismatched.refusal.hostVersion, PROTOCOL_VERSION);
  assert.equal(mismatched.refusal.clientVersion, PROTOCOL_VERSION + 1);
  const raw = await rawLink(track, listener);
  const exit = await raw.hello(PROTOCOL_VERSION + 1);
  assert.ok(failureOf(exit) instanceof ProtocolVersionMismatchError);
  await dialListener(track, listener);
});

it("a frame this end can't read closes the connection, rather than leaving a link that answers nothing", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const raw = await rawLink(track, listener);
  assert.equal(Exit.isSuccess(await raw.hello()), true);
  // Not a message of the link's layout: bytes msgpack never begins with.
  raw.send(new Uint8Array([0, 0, 0, 4, 0xc1, 0xc1, 0xc1, 0xc1]));
  assert.equal(await raw.closed, 1007);
});

it("before the hello: a call is refused, and a hello after the timeout cannot link", async () => {
  const track = trackTest;
  const { listener } = await listen(track, { start: { helloTimeoutMs: 200 } });
  const raw = await rawLink(track, listener);
  const early = failureOf(
    await Effect.runPromiseExit(raw.call("git:sweep", { renewal: true })),
  );
  assert.ok(early instanceof LinkUnauthenticatedError);
  assert.equal(await raw.closed, 4002);
});

it("reach: a call no peer may make never leaves the dialer, and a remote call nothing serves answers no handler", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const connection = await dialListener(track, listener);
  const local = await rejection(invoke(connection, "runtime:nuke"));
  assert.match(
    String(local),
    /No handler registered for channel "runtime:nuke"/,
  );
  const unserved = await rejection(invoke(connection, "projects:list"));
  assert.ok(unserved instanceof RemoteCallError);
  assert.match(unserved.message, /No handler registered/);
});

it("Origin gate: origin-less, loopback and the configured web origin link, while the renderer scheme and a foreign origin are refused", async () => {
  const track = trackTest;
  const { listener } = await listen(track, {
    start: { allowedOrigin: "https://web.example" },
  });
  for (const origin of [
    undefined,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://web.example",
  ]) {
    await dialListener(track, listener, {
      openSocket: withHeaders(origin === undefined ? {} : { origin }),
    });
  }
  for (const origin of [
    rendererSchemeOrigin("prod"),
    rendererSchemeOrigin("dev"),
    "https://evil.example",
  ]) {
    const refused = await dialFails(listener, {
      openSocket: withHeaders({ origin }),
    });
    assert.equal(refused.blocked, false);
  }
});

it("frame cap: a call's frame of 1 MiB crosses the real listener, sealed, whether or not the dialer offers compression", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  for (const deflate of [false, true]) {
    const raw = await rawLink(track, listener, { deflate });
    assert.ok(Exit.isSuccess(await raw.hello()));
    // A served call with nearly a mebibyte in its payload: the frame
    // sits just under the cap, where compression would have pushed the
    // sealed frame over it, and the answer arrives on the same link.
    const answer = await Effect.runPromiseExit(
      raw.call("projects:defaultBranch", {
        projectId: "p".repeat(MAX_MESSAGE_BYTES - 128),
      }),
    );
    assert.ok(
      !(
        Exit.isFailure(answer) &&
        String(Cause.squash(answer.cause)).includes("1009")
      ),
      `the frame closed the socket (compression ${deflate ? "offered" : "off"})`,
    );
    const swept = raw.call("git:sweep", { renewal: true });
    assert.deepEqual(await Effect.runPromise(swept), { leaseMs: 5 });
  }
});

it("frame cap: an inbound frame over 1 MiB and its tag closes the socket", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  track(() => ws.terminate());
  await new Promise((resolve) => ws.once("open", resolve));
  const closed = new Promise<number>((resolve) => ws.on("close", resolve));
  ws.send("x".repeat(MAX_MESSAGE_BYTES + SEAL_OVERHEAD_BYTES + 1));
  assert.equal(await closed, 1009);
});

it("roster: a device dropped after its handshake links nothing: its hello is refused, the sweep closes its socket before any hello, and its pending tickets go", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  // Its handshake done, then the roster drops it, and the sweep has not
  // run: the hello itself refuses.
  const unswept = await rawLink(track, listener);
  await listener.rosterNow([LISTENER], { sweep: false });
  assert.ok(failureOf(await unswept.hello()) instanceof LinkRefusedError);
  // The sweep closes a socket still to say hello.
  await listener.rosterNow([LISTENER, DIALER]);
  const waiting = await rawLink(track, listener);
  const pending = mintTicket(listener.tickets, DIALER);
  await listener.rosterNow([LISTENER]);
  assert.equal(await waiting.closed, 1001);
  // And a ticket it was handed before opens nothing.
  await listener.rosterNow([LISTENER, DIALER]);
  const refused = await dialFails(listener, { ticket: pending });
  assert.ok(refused.refusal instanceof LinkRefusedError);
});

it("hub outage: a hello or a dial the listener cannot check against the roster closes to be dialed again, counts nothing toward the lockout, and the device links once the roster is back", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  // A handshake done while the roster was there, its hello after it
  // went, past the lockout's threshold.
  for (let n = 0; n < 6; n++) {
    listener.rosterUnavailable(false);
    const raw = await rawLink(track, listener);
    listener.rosterUnavailable(true);
    const refusal = failureOf(await raw.hello());
    assert.ok(refusal instanceof RemoteCallError, String(refusal));
    assert.equal(await raw.closed, CLOSE_TRY_AGAIN);
  }
  // Dials while it is gone: refused at the socket, not blocked.
  for (let n = 0; n < 6; n++) {
    const refused = await dialFails(listener);
    assert.equal(refused.blocked, false);
    assert.equal(refused.code, CLOSE_TRY_AGAIN);
  }
  listener.rosterUnavailable(false);
  const connection = await dialListener(track, listener);
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
});

it("tickets: a ticket survives a socket whose handshake fails and one whose first message is replayed, and only the hello that links spends it", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const ticket = mintTicket(listener.tickets, DIALER);
  // A dialer holding the ticket but not the device's key.
  const wrongKey = await dialFails(listener, {
    ticket,
    localKey: generateKeyPair(),
  });
  assert.ok(wrongKey.refusal instanceof LinkRefusedError);
  // The real device's first message, sent once more by someone
  // without the transport keys, who can then say nothing.
  let first: Buffer | undefined;
  const recorder = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  const send = recorder.send.bind(recorder);
  recorder.send = ((data: Buffer) => {
    first ??= Buffer.from(data);
    send(data);
  }) as typeof recorder.send;
  const recorded = sealDialer(
    // ws's socket is a WebSocketLike at runtime, as the dialer hands it over, but its event types differ
    recorder as Socket.WebSocketLike,
    {
      ticket,
      localKey: testDeviceKey(DIALER).pair,
      remoteKey: testDeviceKey(LISTENER).pair.publicKey,
    },
  );
  await new Promise<void>((resolve) =>
    recorded.addEventListener("open", () => resolve()),
  );
  recorder.close();
  assert.ok(first !== undefined);
  const replayClosed = await new Promise<number>((resolve) => {
    const replay = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    replay.on("open", () => replay.send(first as Buffer));
    replay.once("message", () =>
      replay.send(Buffer.from("a frame it cannot seal")),
    );
    replay.on("close", (code) => resolve(code));
    replay.on("error", () => {});
  });
  assert.equal(replayClosed, CLOSE_HANDSHAKE_FAILED);
  // Still pending, so the device links with it, and then it is spent.
  await dialListener(track, listener, { ticket });
  const again = await dialFails(listener, { ticket });
  assert.ok(again.refusal instanceof LinkRefusedError);
});

it("in-flight cap: one call past the per-peer cap is refused rather than run", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  // The raw link: the dialer's own lets fewer out at once
  // (rpcTransport.ts, LINK_CALLS_IN_FLIGHT), and this is the host's
  // cap.
  const raw = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await raw.hello()));
  const calls = Array.from({ length: MAX_IN_FLIGHT_PER_PEER }, () =>
    Effect.runPromise(raw.call("worktrees:list", { projectId: "p" })),
  );
  await waitFor(
    () => seen.hanging.length === MAX_IN_FLIGHT_PER_PEER,
    "every call under the cap to run",
  );
  const over = await Effect.runPromiseExit(
    raw.call("worktrees:list", { projectId: "p" }),
  );
  assert.match(String(over), /too many in-flight requests/);
  for (const call of seen.hanging) call.resolve([]);
  await Promise.all(calls);
});

it("in-flight cap: streams a peer holds open take no place under it", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const raw = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await raw.hello()));
  const open = Array.from({ length: MAX_IN_FLIGHT_PER_PEER + 1 }, () =>
    Effect.runFork(
      Stream.runDrain(
        raw.watch("ports:watch", { projectId: "p", worktreeId: "w" }),
      ),
    ),
  );
  track(() =>
    Promise.all(open.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber)))),
  );
  // Let every stream reach the host before the call.
  await Effect.runPromise(raw.call("link:ping"));
  assert.deepEqual(
    await Effect.runPromise(raw.call("git:sweep", { renewal: true })),
    {
      leaseMs: 5,
    },
  );
});

it("command gate: with commands off a command is refused with the typed error and never runs while a read is served, and turning them on needs no reconnect", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  const connection = await dialListener(track, listener);
  const refused = await rejection(
    invoke(connection, "git:refreshProject", { projectId: "p" }),
  );
  assert.ok(refused instanceof CommandRefusedError);
  assert.equal(seen.refreshes, 0);
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
  listener.setAccepts(true);
  await invoke(connection, "git:refreshProject", { projectId: "p" });
  assert.equal(seen.refreshes, 1);
});

it("commands turned off under a linked peer: its gated views under way end with the typed error while its reads carry on", async () => {
  const track = trackTest;
  let opened = 0;
  const { listener } = await listen(track, {
    registerHandlers: (binding) =>
      binding.view("terminals:list", () =>
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              opened += 1;
            }),
          ).pipe(Stream.drain),
          Stream.never,
        ),
      ),
  });
  listener.setAccepts(true);
  const raw = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await raw.hello()));
  const gated = Effect.runPromiseExit(
    Stream.runDrain(raw.watch("terminals:list")),
  );
  const read = Effect.runFork(
    Stream.runDrain(
      raw.watch("ports:watch", { projectId: "p", worktreeId: "w" }),
    ),
  );
  track(() => Effect.runPromise(Fiber.interrupt(read)));
  await waitFor(() => opened === 1, "the gated view to run");
  listener.setAccepts(false);
  assert.ok(failureOf(await gated) instanceof CommandRefusedError);
  assert.equal(read.pollUnsafe(), undefined, "the read ended");
});

it("what a granted call left going reaches its peer only while commands and sharing are on", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const heard: unknown[] = [];
  connection.transport.subscribe("git:projectChanged", (p) => heard.push(p));
  await invoke(connection, "git:refreshProject", { projectId: "keep" });
  const [notifier] = seen.notifiers;
  assert.ok(notifier !== undefined);
  const say = (projectId: string) =>
    notifier(gitContract, "projectChanged")({ projectId });
  await waitFor(() => {
    say("before");
    return has(heard, "before");
  }, "the peer to hear its call's pushes");
  // Each switch off, then on again: the push between is never heard,
  // and the one after it, on the same ordered stream, shows it would
  // have been by then.
  listener.setAccepts(false);
  say("commands-off");
  listener.setAccepts(true);
  await waitFor(() => {
    say("commands-on");
    return has(heard, "commands-on");
  }, "the peer to hear again");
  listener.setSharing(false);
  say("not-sharing");
  listener.setSharing(true);
  await waitFor(() => {
    say("sharing");
    return has(heard, "sharing");
  }, "the peer to hear again");
  assert.equal(has(heard, "commands-off"), false);
  assert.equal(has(heard, "not-sharing"), false);
});

it("invited calls: with commands off a call the host asked for runs while the rest stay refused, and the byte channel it attached survives the switch-off drop that resets every other as the switch turns, no bytes moving", async () => {
  const track = trackTest;
  const invitedPort = 1;
  const { listener, seen } = await listen(track, {
    isInvited: (peer, channel, input) =>
      peer === DIALER &&
      channel === "forward:open" &&
      (input as { port: number }).port === invitedPort,
  });
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const read = (id: string) => {
    const got: string[] = [];
    let reset = false;
    const handle = connection.channels.attach(id, {
      onData: (data, consumed) => {
        got.push(Buffer.from(data).toString());
        consumed();
      },
      onEnd: () => {},
      onReset: () => {
        reset = true;
      },
      onWritable: () => {},
    });
    return { handle, got, reset: () => reset };
  };
  const granted = read("0123456789abcdef0123456789abcdef");
  await invoke(connection, "forward:open", {
    port: 2,
    channelId: "0123456789abcdef0123456789abcdef",
  });
  const invited = read("fedcba9876543210fedcba9876543210");
  await invoke(connection, "forward:open", {
    port: invitedPort,
    channelId: "fedcba9876543210fedcba9876543210",
  });
  // The switch turning off drops the granted channel then, idle as it
  // is, and the invited one carries on.
  listener.setAccepts(false);
  await waitFor(
    () => seen.channels.get("0123456789abcdef0123456789abcdef")?.reset === true,
    "the granted channel to drop",
  );
  await waitFor(() => granted.reset(), "the dialer to hear the drop");
  const refused = await rejection(
    invoke(connection, "forward:open", {
      port: 3,
      channelId: "00000000000000000000000000000000",
    }),
  );
  assert.ok(refused instanceof CommandRefusedError);
  invited.handle.write(Buffer.from("hello"));
  await waitFor(() => invited.got.join("") === "hello", "the echo");
  assert.equal(invited.reset(), false);
  assert.equal(
    seen.channels.get("fedcba9876543210fedcba9876543210")?.reset,
    false,
  );
});

it("sharing turned off under a linked peer drops its byte channels then, no bytes moving", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  let reset = false;
  connection.channels.attach("0123456789abcdef0123456789abcdef", {
    onData: (_data, consumed) => consumed(),
    onEnd: () => {},
    onReset: () => {
      reset = true;
    },
    onWritable: () => {},
  });
  await invoke(connection, "forward:open", {
    port: 2,
    channelId: "0123456789abcdef0123456789abcdef",
  });
  listener.setSharing(false);
  await waitFor(
    () => seen.channels.get("0123456789abcdef0123456789abcdef")?.reset === true,
    "the channel to drop",
  );
  await waitFor(() => reset, "the dialer to hear the drop");
});

it("sharing gate: with sharing off a peer's reads and commands are refused and never run, and its pushes withheld, while the mirror this device asked for is still served and still hears its copy, and turning it back on needs no reconnect", async () => {
  const track = trackTest;
  const copy = { projectId: "copy-project", worktreeId: "abcdef012345" };
  await runHost(loadMirrorInvites);
  track(() => runHost(dropMirrorInvitesWithPeers(() => false)));
  inviteMirror({
    peerDeviceId: DIALER,
    sourceWorktreeId: "0123456789ab",
    identity: "repo-identity",
  });
  await runHost(landInvitedMirror(DIALER, "0123456789ab", copy));
  const { listener, seen } = await listen(track, {
    isInvited: mirrorInviteAdmits,
    seesPush: mirrorInviteSees,
    registerHandlers: (binding) =>
      binding.handle("worktreeData:read", async () => null),
  });
  listener.setAccepts(true);
  listener.setSharing(false);
  const connection = await dialListener(track, listener);
  const heard: unknown[] = [];
  connection.transport.subscribe("git:projectChanged", (p) => heard.push(p));
  assert.ok(
    (await rejection(
      invoke(connection, "git:sweep", { renewal: true }),
    )) instanceof NotSharingError,
  );
  assert.ok(
    (await rejection(
      invoke(connection, "git:refreshProject", { projectId: "p" }),
    )) instanceof NotSharingError,
  );
  assert.equal(seen.refreshes, 0, "a handler ran while not sharing");
  // The mirror's own call on its copy, and the same call elsewhere.
  assert.equal(await invoke(connection, "worktreeData:read", copy), null);
  assert.ok(
    (await rejection(
      invoke(connection, "worktreeData:read", {
        projectId: copy.projectId,
        worktreeId: "543210fedcba",
      }),
    )) instanceof NotSharingError,
  );
  // A push about another project goes before each one about the copy's,
  // so the copy's arriving alone shows the other was withheld.
  await waitFor(() => {
    listener.binding.broadcastAll("git:projectChanged", {
      projectId: "elsewhere",
    });
    listener.binding.broadcastAll("git:projectChanged", {
      projectId: copy.projectId,
    });
    return has(heard, copy.projectId);
  }, "the mirror to hear its copy");
  assert.equal(has(heard, "elsewhere"), false);
  listener.setSharing(true);
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
  await waitFor(() => {
    listener.binding.broadcastAll("git:projectChanged", {
      projectId: "elsewhere",
    });
    return has(heard, "elsewhere");
  }, "the peer to hear the rest again");
});

it("sharing flipped under a linked peer: its calls and views under way end with NotSharingError, its handler's signal aborted, and it hears the switch both ways", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track, {
    registerHandlers: (binding) =>
      binding.view("sharedSettings:watch", () => Stream.never),
  });
  // Its own device: the raw link below says hello as DIALER.
  const connection = await dialListener(track, listener, { dialer: "second" });
  const flips: unknown[] = [];
  const fence: unknown[] = [];
  connection.transport.subscribe("sharing:changed", (on) => flips.push(on));
  connection.transport.subscribe("git:projectChanged", (p) => fence.push(p));
  // The link's push streams are up once a push reaches it.
  await waitFor(() => {
    listener.binding.broadcastAll("git:projectChanged", { projectId: "up" });
    return has(fence, "up");
  }, "the peer's pushes to be up");
  const raw = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await raw.hello()));
  const view = Effect.runPromiseExit(
    Stream.runDrain(raw.watch("sharedSettings:watch")),
  );
  const call = rejection(
    invoke(connection, "worktrees:list", { projectId: "p" }),
  );
  await waitFor(() => seen.hanging.length === 1, "the call to run");
  listener.setSharing(false);
  assert.ok((await call) instanceof NotSharingError);
  assert.ok(failureOf(await view) instanceof NotSharingError);
  await waitFor(
    () => seen.hanging[0]?.signal.aborted === true,
    "the handler's signal to abort",
  );
  await waitFor(() => flips.includes(false), "the peer to hear it go off");
  // The command switch's word still reaches it while it is off.
  const grants: unknown[] = [];
  connection.transport.subscribe("account:commandAccessChanged", (on) =>
    grants.push(on),
  );
  listener.setAccepts(true);
  await waitFor(() => grants.includes(true), "the peer to hear the grant");
  listener.setSharing(true);
  await waitFor(() => flips.includes(true), "the peer to hear it come on");
});

it("byte channels: bytes cross both ways in order, and an end on each side completes the channel", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const id = "abcdefabcdefabcdefabcdefabcdef12";
  const got: string[] = [];
  let ended = false;
  let completed = false;
  const handle = connection.channels.attach(id, {
    onData: (data, consumed) => {
      got.push(Buffer.from(data).toString());
      consumed();
    },
    onEnd: () => {
      ended = true;
    },
    onReset: () => assert.fail("the channel reset"),
    onComplete: () => {
      completed = true;
    },
    onWritable: () => {},
  });
  // Bytes written before the open attached the far end wait for it.
  for (let n = 0; n < 50; n++) handle.write(Buffer.from(`${n},`));
  await invoke(connection, "forward:open", { port: 2, channelId: id });
  const want = Array.from({ length: 50 }, (_, n) => `${n},`).join("");
  await waitFor(() => got.join("") === want, "the echo, in order");
  assert.equal(seen.channels.get(id)?.data.join(""), want);
  handle.end();
  await waitFor(() => ended && completed, "both ends to finish");
  assert.equal(connection.channels.has(id), false);
});

it("byte channels: a reader that holds its pieces holds back its own channel alone, and the link's calls still answer", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const id = "abcdefabcdefabcdefabcdefabcdef34";
  // A reader busy elsewhere, as a send's source is while it writes its
  // bundle: the echo's pieces wait untaken.
  const held: (() => void)[] = [];
  const got: string[] = [];
  const handle = connection.channels.attach(id, {
    onData: (data, consumed) => {
      got.push(Buffer.from(data).toString());
      held.push(consumed);
    },
    onEnd: () => {},
    onReset: () => assert.fail("the channel reset"),
    onWritable: () => {},
  });
  await invoke(connection, "forward:open", { port: 2, channelId: id });
  for (let n = 0; n < 200; n++) handle.write(Buffer.from(`${n},`));
  await waitFor(() => held.length > 0, "the first echoed piece");
  // Past where a reader's stalled stream once stopped the whole socket.
  await delay(200);
  const answered = await Promise.race([
    invoke(connection, "git:sweep", { renewal: true }).then(() => true),
    delay(3_000).then(() => false),
  ]);
  assert.equal(answered, true, "a call on the link answers past the stall");
  const want = Array.from({ length: 200 }, (_, n) => `${n},`).join("");
  for (let turn = 0; got.join("") !== want; turn++) {
    assert.ok(turn < 500, "the held pieces to come through once taken");
    for (const consumed of held.splice(0)) consumed();
    await delay(10);
  }
});

it("byte channels: the reads idle channels hold take no place under the in-flight cap", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  // Twelve channels with nothing to say, each holding its reads ahead
  // on the host: past the cap's 64 calls.
  let resets = 0;
  const ids: string[] = [];
  for (let n = 0; n < 12; n++) {
    const id = mintHexId();
    ids.push(id);
    connection.channels.attach(id, {
      onData: (_data, consumed) => consumed(),
      onEnd: () => {},
      onReset: () => {
        resets += 1;
      },
      onWritable: () => {},
    });
    await invoke(connection, "forward:open", { port: 2, channelId: id });
  }
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
  await delay(200);
  assert.equal(resets, 0, "no channel was refused its reads");
  assert.ok(ids.every((id) => connection.channels.has(id)));
});

it("streams: a client behind a flood is handed it in messages within the cap, and the link's calls still answer", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const frames: number[] = [];
  const connection = await dialListener(track, listener, {
    openSocket: hearingFrames((bytes) => frames.push(bytes)),
  });
  let events = 0;
  await new Promise<void>((resolve, reject) => {
    connection.transport.watch?.(
      "terminals:attach",
      { terminalId: "flood" },
      {
        value: () => {
          events += 1;
        },
        end: (failure) =>
          failure === undefined ? resolve() : reject(failure as Error),
      },
    );
  });
  assert.equal(events, FLOOD_CHUNKS);
  // A message's frame: the message, its envelope and the seal's tag.
  assert.ok(
    Math.max(...frames) <= MAX_MESSAGE_BYTES + 1024,
    `a frame of ${Math.max(...frames)} bytes`,
  );
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
});

it("relay: a window that falls behind a peer's flood has its view ended as no session once this host holds the backlog, the flood stops, and the link's calls still answer", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  listener.setAccepts(true);
  const connection = await dialListener(track, listener);
  const hub = bridgeOver(connection);
  await hub.dialPeer(LISTENER);
  // A window that takes three values, then nothing until it is let go.
  let taken = 0;
  const behind = Deferred.makeUnsafe<void>();
  const window = Effect.runPromiseExit(
    Stream.runForEach(
      servedWatchPeer(() => hub)({
        deviceId: LISTENER,
        channel: "terminals:attach",
        input: { terminalId: "endless" },
      }),
      () => (++taken === 3 ? Deferred.await(behind) : Effect.void),
    ),
  );
  await waitFor(() => taken === 3, "the window's three values");
  assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
  await waitFor(
    () => seen.pulled > RELAY_BACKLOG + 3,
    "the flood to pass the backlog",
  );
  // The window still behind: the flood has stopped all the same.
  await delay(300);
  const pulled = seen.pulled;
  await delay(200);
  assert.ok(pulled < ENDLESS_CHUNKS, "the whole flood was read");
  assert.equal(seen.pulled, pulled, "the flood went on past the backlog");
  Effect.runSync(Deferred.succeed(behind, undefined));
  const failure = failureOf(await window);
  assert.ok(failure instanceof NoDirectConnectionError, String(failure));
  assert.ok(taken <= RELAY_BACKLOG + 3, `the window was handed ${taken}`);
});

it("views: a view on a link this side closes ends as a disconnect, which a window's host relays as no session", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const connection = await dialListener(track, listener);
  const hub = bridgeOver(connection);
  await hub.dialPeer(LISTENER);
  const watched = new Promise<unknown>((resolve) => {
    connection.transport.watch?.("ports:watch", WORKTREE, {
      value: () => {},
      end: resolve,
    });
  });
  const relayed = Effect.runPromiseExit(
    Stream.runDrain(
      servedWatchPeer(() => hub)({
        deviceId: LISTENER,
        channel: "ports:watch",
        input: WORKTREE,
      }),
    ),
  );
  // Both views running on the host before the link goes.
  await delay(100);
  connection.close();
  assert.ok((await watched) instanceof RemoteDisconnectedError);
  assert.ok(failureOf(await relayed) instanceof NoDirectConnectionError);
});

it("close: a link the host cuts while its dialer goes on calling writes nothing to the socket once it is closing, and the calls reject as a disconnect", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  let late = 0;
  let closes = 0;
  const connection = await dialListener(track, listener, {
    openSocket: (url) => {
      const ws = new WebSocket(url);
      const send = ws.send.bind(ws);
      ws.send = ((...args: Parameters<typeof send>) => {
        if (ws.readyState !== WebSocket.OPEN) late += 1;
        send(...args);
      }) as typeof ws.send;
      return ws;
    },
    onClose: () => closes++,
  });
  // A page busy through its sign-out: a call every turn of the loop.
  const failures: unknown[] = [];
  const calling = () => {
    if (closes > 0) return;
    invoke(connection, "git:sweep", { renewal: true }).catch((error) =>
      failures.push(error),
    );
    setImmediate(calling);
  };
  calling();
  await listener.binding.closePeersNotIn([]);
  await waitFor(() => closes === 1, "the dialer to hear the drop");
  await delay(100);
  assert.equal(late, 0, "writes to the socket once it was closing");
  assert.ok(failures.length > 0);
  assert.ok(
    failures.every((error) => error instanceof RemoteDisconnectedError),
    String(
      failures.find((error) => !(error instanceof RemoteDisconnectedError)),
    ),
  );
});

it("streams: a frame past the decoder's cap drops the link rather than failing every call after it, and a dial again answers", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  let closes = 0;
  const connection = await dialListener(track, listener, {
    onClose: () => closes++,
  });
  connection.transport.watch?.(
    "terminals:attach",
    { terminalId: "huge" },
    { value: () => {}, end: () => {} },
  );
  await waitFor(() => closes === 1, "the link to drop");
  const again = await dialListener(track, listener);
  assert.deepEqual(await invoke(again, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
});

it("interruption: a call its caller cancels is interrupted on the host, its handler's signal aborted", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  const connection = await dialListener(track, listener);
  const cancel = new AbortController();
  const call = rejection(
    invoke(connection, "worktrees:list", { projectId: "p" }, cancel.signal),
  );
  await waitFor(() => seen.hanging.length === 1, "the call to run");
  cancel.abort();
  await call;
  await waitFor(
    () => seen.hanging[0]?.signal.aborted === true,
    "the handler's signal to abort",
  );
});

it("drop: a link the host cuts aborts its calls, rejects them as a disconnect, and tells the dialer once", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  let closes = 0;
  const connection = await dialListener(track, listener, {
    onClose: () => closes++,
  });
  const call = rejection(
    invoke(connection, "worktrees:list", { projectId: "p" }),
  );
  await waitFor(() => seen.hanging.length === 1, "the call to run");
  await listener.binding.closePeersNotIn([]);
  assert.match(String(await call), /remote device disconnected/);
  await waitFor(() => seen.hanging[0]?.signal.aborted === true, "the abort");
  await waitFor(() => closes === 1, "the dialer to hear the drop");
});

it("supersede: a second link from the same device ends the first", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  let firstClosed = false;
  await dialListener(track, listener, { onClose: () => (firstClosed = true) });
  const second = await dialListener(track, listener);
  await waitFor(() => firstClosed, "the first link to end");
  assert.deepEqual(await invoke(second, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
});

it("tabs: a web device holds a link per tab, each hears its own pushes, and one closing leaves the other", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  let firstClosed = false;
  const first = await dialListener(track, listener, {
    deviceKind: "web",
    onClose: () => (firstClosed = true),
  });
  const second = await dialListener(track, listener, { deviceKind: "web" });
  const heard = { first: [] as unknown[], second: [] as unknown[] };
  first.transport.subscribe("git:projectChanged", (p) => heard.first.push(p));
  second.transport.subscribe("git:projectChanged", (p) => heard.second.push(p));
  await waitFor(() => {
    listener.binding.broadcastAll("git:projectChanged", { projectId: "all" });
    return heard.first.length > 0 && heard.second.length > 0;
  }, "both tabs to hear the broadcast");
  assert.equal(firstClosed, false);
  // A handler's notifier reaches the tab that called, not its sibling.
  await invoke(second, "git:refreshProject", { projectId: "notify" });
  await waitFor(() => has(heard.second, "mine"), "the caller to hear it");
  listener.binding.broadcastAll("git:projectChanged", { projectId: "fence" });
  await waitFor(() => has(heard.first, "fence"), "the sibling the fence");
  assert.equal(has(heard.first, "mine"), false);
  // A tab that goes leaves its sibling linked.
  first.close();
  assert.deepEqual(await invoke(second, "git:sweep", { renewal: true }), {
    leaseMs: 5,
  });
});

it("tabs: a hello with a connection id already held replaces that link alone", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const tab = { deviceKind: "web" as const, connectionId: "a".repeat(32) };
  const stale = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await stale.hello(PROTOCOL_VERSION, tab)));
  let siblingClosed = false;
  await dialListener(track, listener, {
    deviceKind: "web",
    onClose: () => (siblingClosed = true),
  });
  const redial = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await redial.hello(PROTOCOL_VERSION, tab)));
  assert.equal(await stale.closed, 1001);
  assert.equal(siblingClosed, false);
});

it("liveness: the host cuts a linked peer that falls silent past the timeout", async () => {
  const track = trackTest;
  const { listener } = await listen(track, {
    start: { livenessTimeoutMs: 300 },
  });
  const raw = await rawLink(track, listener, { pingInterval: 60_000 });
  const exit = await raw.hello();
  assert.ok(Exit.isSuccess(exit));
  assert.equal(await raw.closed, 1001);
});

it("liveness: the host's cut of a silent peer is monotonic, and a sweep that came late (the host stopped, then continued) is a fresh observation, not a verdict", async () => {
  const track = trackTest;
  const clock = testClock();
  const { wall, sleep, stop } = sleepingClock(clock);
  const { listener } = await listen(track, {
    start: { livenessTimeoutMs: 300 },
    provide: Layer.succeed(Clock.Clock, wall),
  });
  const raw = await rawLink(track, listener, { pingInterval: 60_000 });
  assert.ok(Exit.isSuccess(await raw.hello()));
  let cut = false;
  void raw.closed.then(() => (cut = true));
  const sweeps = async (count: number) => {
    for (let turn = 0; turn < count; turn++) await clock.advance(75);
    await delay(20);
  };
  // The host stopped for ten seconds: its first sweep after is late.
  stop(10_000);
  await sweeps(2);
  // And the wall clock stepped two hours either way, monotonic time still.
  sleep(2 * 3_600_000);
  await sweeps(1);
  sleep(-4 * 3_600_000);
  await sweeps(1);
  assert.equal(cut, false, "a late sweep or a clock step cut the peer");
  // Silent on on-time sweeps: cut.
  await sweeps(4);
  assert.equal(await raw.closed, 1001);
});

it("liveness: a sweep's lateness is no peer's silence, a stall short of twice the sweep included", async () => {
  const track = trackTest;
  const clock = testClock();
  const { wall, stop } = sleepingClock(clock);
  const { listener } = await listen(track, {
    start: { livenessTimeoutMs: 300 },
    provide: Layer.succeed(Clock.Clock, wall),
  });
  const raw = await rawLink(track, listener, { pingInterval: 60_000 });
  assert.ok(Exit.isSuccess(await raw.hello()));
  let cut = false;
  void raw.closed.then(() => (cut = true));
  // Its last frame between two sweeps (75 ms apart).
  await clock.advance(10);
  await Effect.runPromise(raw.call("link:ping"));
  await clock.advance(65);
  await clock.advance(75);
  await clock.advance(75);
  await delay(20);
  // 215 ms silent, then the host stalls 60 ms: its next sweep comes
  // 135 ms after the last, and finds 290 ms of silence awake.
  stop(60);
  await clock.advance(75);
  await delay(20);
  assert.equal(cut, false, "the stall counted as silence");
  await clock.advance(75);
  assert.equal(await raw.closed, 1001);
});

it("liveness: a dialer cuts a peer only on a probe it had the whole timeout to answer: not across a hidden page's minute-late turns, and on time once the peer goes silent", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const clock = testClock();
  const { wall, stop } = sleepingClock(clock);
  // A peer that goes silent: its frames stop reaching the dialer while
  // the socket stays open.
  let deaf = false;
  let closed = 0;
  const connection = await dialListener(track, listener, {
    clock: wall,
    onClose: () => (closed += 1),
    openSocket: (url) => {
      const ws = new WebSocket(url);
      const emit = ws.emit.bind(ws);
      ws.emit = (event: string | symbol, ...args: unknown[]) =>
        deaf && event === "message" ? false : emit(event, ...args);
      return ws;
    },
  });
  const answers = async () =>
    assert.deepEqual(await invoke(connection, "git:sweep", { renewal: true }), {
      leaseMs: 5,
    });
  // Ten minutes of a throttled page: whatever a timer asked for, it
  // runs about a minute late.
  for (let turn = 0; turn < 120; turn++) {
    stop(55_000);
    await clock.advance(5_000);
  }
  await answers();
  assert.equal(closed, 0, "a link cut on a probe it had no turn to answer");
  // The peer goes silent while the dialer's turns come on time.
  deaf = true;
  for (let turn = 0; turn < 4; turn++) await clock.advance(15_000);
  await waitFor(() => closed === 1, "the silent peer's link to be cut");
});

it("stop: the listener stopping closes every link, and nothing answers after", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  let closed = false;
  await dialListener(track, listener, { onClose: () => (closed = true) });
  await listener.binding.reconcile(null);
  await waitFor(() => closed, "the link to close");
  const after = await dialFails(listener);
  assert.equal(after.blocked, false);
});

it("port: a host that restarts listens on the port it listened on last, so its LAN address and its tunnel's ingress stay right, and one another process holds falls back to any", async () => {
  const track = trackTest;
  const dir = mkdtempSync(join(tmpdir(), "sm-port-"));
  track(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "direct-port");
  const opts = {
    bindAddress: "127.0.0.1",
    deviceId: LISTENER,
    appVersion: "2.0.0",
    helloTimeoutMs: 1000,
  };
  // The host's refresh (host/process/wires.ts) on a listener of its own.
  const refresh = async (listener: DirectListener) =>
    runHost(
      reconcileOnLastPort(
        {
          reconcile: (wanted) =>
            Effect.flatMap(wanted, (next) =>
              Effect.promise(() => listener.binding.reconcile(next)),
            ),
          status: Effect.sync(() => {
            const now = listener.binding.status();
            return { ...now, bindAddress: null, error: null };
          }),
        },
        path,
        Effect.succeed(opts),
      ),
    );
  // The first start: any port, remembered.
  const { listener } = await listen(track);
  await refresh(listener);
  const port = listener.port;
  assert.equal(await runHost(rememberedPort(path)), port);
  // A restart: stopped, then refreshed again on the remembered port.
  await listener.binding.reconcile(null);
  await refresh(listener);
  assert.equal(listener.binding.status().port, port);
  // That port held by another listener: any other, remembered in its
  // place.
  const { listener: other } = await listen(track);
  await refresh(other);
  const moved = other.binding.status().port;
  assert.ok(moved !== null && moved !== port);
  assert.equal(await runHost(rememberedPort(path)), moved);
  // An unreadable file is no port.
  writeFileSync(path, "not a port\n");
  assert.equal(await runHost(rememberedPort(path)), 0);
});

it("views: a view streams its values over the link, and one nothing serves fails as RemoteCallError", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const raw = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await raw.hello()));
  const values = await Effect.runPromise(
    Stream.runCollect(raw.watch("projects:watch")),
  );
  assert.deepEqual(values, [[], []]);
  const unserved = failureOf(
    await Effect.runPromiseExit(Stream.runCollect(raw.watch("mirror:watch"))),
  );
  assert.ok(unserved instanceof RemoteCallError);
});

it("tracing: the host's span for a call continues the caller's trace", async () => {
  const track = trackTest;
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const { listener } = await listen(track, {
    provide: Layer.succeed(Tracer.Tracer, tracer),
  });
  const raw = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await raw.hello()));
  const traceId = await Effect.runPromise(
    raw.call("git:sweep", { renewal: true }).pipe(
      Effect.andThen(Effect.currentSpan),
      Effect.map((span) => span.traceId),
      Effect.withSpan("caller"),
    ),
  );
  const served = spans.find((span) => span.name === "DeviceLink.git:sweep");
  assert.ok(served !== undefined, "the host traced the call");
  assert.equal(served.traceId, traceId);
});

it("contract invariant: every host invoke classifies itself, and every remote gated one names its consent line, as grants.ts lists", async () => {
  // Derive the host modules from the authoritative registry rather
  // than a hand-maintained list, so a newly added host contract module
  // is covered here automatically. A module that forgot to tag a call
  // remote can no longer skip this check by never appearing in a list.
  const hostModules = allContractModules.filter((m) => scopeOf(m) === "host");
  // The known host-module count at authoring time. The derived set must
  // cover every host module: an empty or shrunken set means the
  // registry import or the scope filter drifted and the invariant
  // quietly stopped running over some modules.
  const KNOWN_HOST_MODULE_COUNT = 16;
  assert.ok(
    hostModules.length >= KNOWN_HOST_MODULE_COUNT,
    `host-module coverage shrank: derived ${hostModules.length} host modules, expected at least ${KNOWN_HOST_MODULE_COUNT}`,
  );
  // Every group the app serves, the CLI's control contract included.
  const granted = new Map<string, string[]>();
  for (const module of [
    ...allContractModules,
    controlContract,
    guideDriveContract,
  ]) {
    for (const call of callsOf(module)) {
      // The registrar's fail-closed rule: a host invoke says whether it
      // is remote, a remote one whether it is gated, and a remote gated
      // one which consent line covers it.
      assert.equal(classificationGap(call), null);
      const grant = annotation(call, Grant);
      if (grant !== undefined) {
        granted.set(grant, [...(granted.get(grant) ?? []), channelOf(call)]);
      }
    }
  }
  // The consent table (grants.ts) lists exactly the calls that name
  // each line, so reading it is reading what the switch hands over.
  for (const [grant, { calls }] of Object.entries(GRANTS)) {
    assert.deepEqual(
      (granted.get(grant) ?? []).toSorted(),
      calls.toSorted(),
      `grants.ts ${grant} lists other calls than the ones naming it`,
    );
  }
  // The device-settings write, the only settings write: its STRICT
  // patch schema must reject every key the Settings
  // form does not manage, so a peer cannot stop this device serving
  // peers or point it at another connector binary. The rejection is
  // structural (unknown key -> parse error), not a strip.
  const writeDeviceSettings = callOf(
    globalConfigContract,
    "writeDeviceSettings",
  );
  for (const patch of [
    { directConnections: false },
    { cloudflaredPath: "/tmp/not-cloudflared" },
  ]) {
    assert.equal(
      safeDecode(writeDeviceSettings.payloadSchema, { patch }).success,
      false,
      `writeDeviceSettings accepted ${JSON.stringify(patch)}`,
    );
  }
  assert.equal(
    safeDecode(writeDeviceSettings.payloadSchema, { patch: {} }).success,
    true,
    "an empty patch must parse",
  );
  assert.equal(
    safeDecode(writeDeviceSettings.payloadSchema, {
      patch: { githubCli: false, portPool: true },
    }).success,
    true,
    "a managed-keys patch must parse",
  );
});
