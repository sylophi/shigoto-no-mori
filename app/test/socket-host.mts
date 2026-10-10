// Durable proof for the device link's listener (host/socket/server.ts)
// and its dialer (shared/remote/deviceLink.ts): a real listener on an
// ephemeral loopback port (test/lib/directBoot.mts), dialed through the
// ticket handshake by the real client, asserting the calls, the pushes,
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
// its calls and views under way end, and it hears the switch both ways.
//
// Interruption: a call its caller cancels, or whose link drops, is
// interrupted on the host, its handler's signal aborted. Views stream
// their values. Tracing: the host's span for a call continues the
// caller's trace.
//
// The golden read surface: every channel servable ungated (remote:true,
// gated:false) is pinned in read-surface.golden.json, so flipping a
// mutating tag shows up as a reviewed diff instead of silently opening
// or closing the ungated wire. Regenerate deliberately with
// `pnpm test socket-host -u`.
//
// Run: pnpm test socket-host.
//
// covers: app/test/read-surface.golden.json app/host/process/wires.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import {
  CommandRefusedError,
  LinkRefusedError,
  LinkUnauthenticatedError,
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
  Gated,
  Grant,
  isBroadcast,
  payloadOf,
  Remote,
  scopeOf,
} from "@shigomori/contracts/contract";
import { GRANTS } from "@shigomori/contracts/grants";
import { controlContract } from "@shigomori/contracts/modules/control";
import { safeDecode } from "@shigomori/contracts/codec";
import { classificationGap } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import { accountContract } from "@shigomori/contracts/modules/account";
import { allContractModules } from "@shigomori/contracts/allModules";
import { cliContract } from "@shigomori/contracts/modules/cli";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { fsContract } from "@shigomori/contracts/modules/fs";
import { gitContract } from "@shigomori/contracts/modules/git";
import { globalConfigContract } from "@shigomori/contracts/modules/globalConfig";
import { launchersContract } from "@shigomori/contracts/modules/launchers";
import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import {
  type DeviceConnection,
  openDevice,
  RemoteConnectError,
} from "@shared/remote/deviceLink";
import { LinkGroup } from "@shigomori/contracts/link";
import {
  CLOSE_HANDSHAKE_FAILED,
  sealDialer,
} from "@shared/remote/sealedSocket";
import { MAX_IN_FLIGHT_PER_PEER } from "@shared/remote/link";
import {
  inviteMirror,
  landInvitedMirror,
  mirrorInviteAdmits,
  mirrorInviteSees,
  setMirrorInviteStore,
} from "@host/mirror/invites";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import type { ChannelHandle } from "@shigomori/contracts/link";
import { type Track, waitFor } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import {
  type DirectListener,
  type DirectListenerOpts,
  mintTicket,
  startDirectListener,
} from "./lib/directBoot.mts";
import { testDeviceKey } from "./lib/hubStub.mts";

// The dialing peer every ticket below is minted for.
const CLIENT = "client";
const HOST = "B";

// What the test handlers saw.
type Seen = {
  refreshes: number;
  hanging: { signal: AbortSignal; resolve: (value: unknown) => void }[];
  channels: Map<
    string,
    { data: string[]; reset: boolean; handle: ChannelHandle | null }
  >;
};

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
  });
  binding.handle("worktrees:list", (ctx) => hang(seen, ctx));
  // A view: what the projects list reads as, twice.
  binding.view("projects:watch", () => Stream.make([], []));
  // A view that never ends, as a live one doesn't.
  binding.view("ports:watch", () => Stream.never);
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

function hang(seen: Seen, ctx: HandlerContext): Promise<unknown> {
  return new Promise((resolve) => {
    seen.hanging.push({ signal: ctx.signal, resolve });
  });
}

async function listen(
  track: Track,
  opts: DirectListenerOpts = {},
): Promise<{ listener: DirectListener; seen: Seen }> {
  const seen: Seen = { refreshes: 0, hanging: [], channels: new Map() };
  const listener = await startDirectListener(track, {
    deviceId: HOST,
    ...opts,
    registerHandlers: (binding) => {
      serve({ binding } as DirectListener, seen);
      opts.registerHandlers?.(binding);
    },
  });
  return { listener, seen };
}

type DialOpts = {
  deviceId?: string;
  ticket?: string;
  headers?: Record<string, string>;
  onClose?: () => void;
  protocolVersion?: number;
  deviceKind?: "desktop" | "web";
};

function dialing(listener: DirectListener, opts: DialOpts = {}) {
  const deviceId = opts.deviceId ?? CLIENT;
  return openDevice({
    url: `ws://127.0.0.1:${listener.port}`,
    ticket: opts.ticket ?? mintTicket(listener.tickets, deviceId),
    seal: {
      localKey: testDeviceKey(deviceId).pair,
      remoteKey: testDeviceKey(HOST).pair.publicKey,
    },
    appVersion: "1.0.0",
    localDeviceId: deviceId,
    expectedDeviceId: HOST,
    onClose: opts.onClose ?? (() => {}),
    openSocket: (url) => new WebSocket(url, { headers: opts.headers }),
    deadlineMs: 3000,
    ...(opts.deviceKind === undefined ? {} : { deviceKind: opts.deviceKind }),
    ...(opts.protocolVersion === undefined
      ? {}
      : { protocolVersion: opts.protocolVersion }),
  });
}

async function dial(
  track: Track,
  listener: DirectListener,
  opts: DialOpts = {},
): Promise<DeviceConnection> {
  const connection = await dialing(listener, opts).authenticate();
  track(() => connection.close());
  return connection;
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

const invoke = (
  connection: DeviceConnection,
  channel: string,
  input?: unknown,
  signal?: AbortSignal,
) => connection.transport.invoke(channel, input, { signal });

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
  opts: { pingInterval?: number } = {},
) {
  const scope = Scope.makeUnsafe();
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  const closed = new Promise<number>((resolve) =>
    ws.on("close", (code) => resolve(code)),
  );
  // Sealed like the dialer's, with a ticket minted for CLIENT.
  // oxlint-disable-next-line shigomori/no-double-cast -- ws's socket is a WebSocketLike at runtime, as the dialer hands it over, but its event types differ
  const sealed = sealDialer(ws as unknown as Socket.WebSocketLike, {
    ticket: mintTicket(listener.tickets, CLIENT),
    localKey: testDeviceKey(CLIENT).pair,
    remoteKey: testDeviceKey(HOST).pair.publicKey,
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
        deviceId: CLIENT,
        ...as,
        appVersion: "1.0.0",
        protocolVersion,
      }),
    );
  return { call, watch, hello, closed };
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isFailure(exit), "the call succeeded");
  return Cause.squash(exit.cause);
};

it("handshake: a proven ticket links, and the welcome names the host and proves the ticket", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const connection = await dial(track, listener);
  assert.equal(connection.remoteDeviceId, HOST);
  assert.equal(connection.remoteAppVersion, "2.0.0");
});

it("calls: a read answers with its result, and a failure crosses as its contract error, or as RemoteCallError with its message and code", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const connection = await dial(track, listener);
  assert.deepEqual(await invoke(connection, "git:sweep"), { leaseMs: 5 });
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

const has = (pushes: unknown[], projectId: string) =>
  pushes.some(
    (push) => (push as { projectId: string }).projectId === projectId,
  );

it("pushes: a broadcast reaches every linked peer, and a handler's notifier only its caller", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  const heard = { one: [] as unknown[], two: [] as unknown[] };
  const one = await dial(track, listener, {
    deviceId: "one",
  });
  const two = await dial(track, listener, { deviceId: "two" });
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
    // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
    const refused = await dialFails(listener, { ticket: "smpt_never_minted" });
    assert.equal(refused.blocked, true);
    assert.ok(refused.refusal instanceof LinkRefusedError);
  }
  const locked = await dialFails(listener);
  assert.equal(locked.blocked, false);
  assert.equal(locked.code, 4003);
});

it("lockout: a device on another version, refused past the threshold, leaves a correct dial from the same address accepted", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  // A build before sealed links opens with a clear frame of its own.
  for (let attempt = 0; attempt < 6; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
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
    // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
    const refused = await dialFails(listener, {
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    assert.ok(refused.refusal instanceof ProtocolVersionMismatchError);
  }
  const connection = await dial(track, listener);
  assert.deepEqual(await invoke(connection, "git:sweep"), { leaseMs: 5 });
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
  await dial(track, listener);
});

it("before the hello: a call is refused, and a hello after the timeout cannot link", async () => {
  const track = trackTest;
  const { listener } = await listen(track, { start: { helloTimeoutMs: 200 } });
  const raw = await rawLink(track, listener);
  const early = failureOf(await Effect.runPromiseExit(raw.call("git:sweep")));
  assert.ok(early instanceof LinkUnauthenticatedError);
  assert.equal(await raw.closed, 4002);
});

it("reach: a call no peer may make never leaves the dialer, and a remote call nothing serves answers no handler", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const connection = await dial(track, listener);
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
    // oxlint-disable-next-line no-await-in-loop -- one dial at a time
    await dial(track, listener, {
      headers: origin === undefined ? {} : { origin },
    });
  }
  for (const origin of [
    rendererSchemeOrigin("prod"),
    rendererSchemeOrigin("dev"),
    "https://evil.example",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one dial at a time
    const refused = await dialFails(listener, { headers: { origin } });
    assert.equal(refused.blocked, false);
  }
});

it("frame cap: an inbound frame over 1 MiB closes the socket", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  track(() => ws.terminate());
  await new Promise((resolve) => ws.once("open", resolve));
  const closed = new Promise<number>((resolve) => ws.on("close", resolve));
  ws.send("x".repeat((1 << 20) + 1));
  assert.equal(await closed, 1009);
});

it("in-flight cap: one call past the per-peer cap is refused rather than run", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  const connection = await dial(track, listener);
  const calls = Array.from({ length: MAX_IN_FLIGHT_PER_PEER }, () =>
    invoke(connection, "worktrees:list", { projectId: "p" }),
  );
  await waitFor(
    () => seen.hanging.length === MAX_IN_FLIGHT_PER_PEER,
    "every call under the cap to run",
  );
  const over = await rejection(
    invoke(connection, "worktrees:list", { projectId: "p" }),
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
  assert.deepEqual(await Effect.runPromise(raw.call("git:sweep")), {
    leaseMs: 5,
  });
});

it("command gate: with commands off a command is refused with the typed error and never runs while a read is served, and turning them on needs no reconnect", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  const connection = await dial(track, listener);
  const refused = await rejection(
    invoke(connection, "git:refreshProject", { projectId: "p" }),
  );
  assert.ok(refused instanceof CommandRefusedError);
  assert.equal(seen.refreshes, 0);
  assert.deepEqual(await invoke(connection, "git:sweep"), { leaseMs: 5 });
  listener.setAccepts(true);
  await invoke(connection, "git:refreshProject", { projectId: "p" });
  assert.equal(seen.refreshes, 1);
});

it("invited calls: with commands off a call the host asked for runs while the rest stay refused, and the byte channel it attached survives the switch-off drop that resets every other", async () => {
  const track = trackTest;
  const invitedPort = 1;
  const { listener, seen } = await listen(track, {
    isInvited: (peer, channel, input) =>
      peer === CLIENT &&
      channel === "forward:open" &&
      (input as { port: number }).port === invitedPort,
  });
  listener.setAccepts(true);
  const connection = await dial(track, listener);
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
  listener.setAccepts(false);
  const invited = read("fedcba9876543210fedcba9876543210");
  await invoke(connection, "forward:open", {
    port: invitedPort,
    channelId: "fedcba9876543210fedcba9876543210",
  });
  const refused = await rejection(
    invoke(connection, "forward:open", {
      port: 3,
      channelId: "00000000000000000000000000000000",
    }),
  );
  assert.ok(refused instanceof CommandRefusedError);
  // The next bytes find the switch off: the granted channel goes, the
  // invited one carries on.
  invited.handle.write(Buffer.from("hello"));
  await waitFor(() => invited.got.join("") === "hello", "the echo");
  await waitFor(
    () => seen.channels.get("0123456789abcdef0123456789abcdef")?.reset === true,
    "the granted channel to drop",
  );
  await waitFor(() => granted.reset(), "the dialer to hear the drop");
  assert.equal(invited.reset(), false);
});

it("sharing gate: with sharing off a peer's reads and commands are refused and never run, and its pushes withheld, while the mirror this device asked for is still served and still hears its copy, and turning it back on needs no reconnect", async () => {
  const track = trackTest;
  const copy = { projectId: "copy-project", worktreeId: "abcdef012345" };
  setMirrorInviteStore({ load: () => [], save: () => {} });
  track(() => setMirrorInviteStore(null));
  inviteMirror({
    peerDeviceId: CLIENT,
    sourceWorktreeId: "0123456789ab",
    identity: "repo-identity",
  });
  landInvitedMirror(CLIENT, "0123456789ab", copy);
  const { listener, seen } = await listen(track, {
    isInvited: mirrorInviteAdmits,
    seesPush: mirrorInviteSees,
    registerHandlers: (binding) =>
      binding.handle("worktreeData:read", async () => null),
  });
  listener.setAccepts(true);
  listener.setSharing(false);
  const connection = await dial(track, listener);
  const heard: unknown[] = [];
  connection.transport.subscribe("git:projectChanged", (p) => heard.push(p));
  assert.ok(
    (await rejection(invoke(connection, "git:sweep"))) instanceof
      NotSharingError,
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
  assert.deepEqual(await invoke(connection, "git:sweep"), { leaseMs: 5 });
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
  // Its own device: the raw link below says hello as CLIENT.
  const connection = await dial(track, listener, { deviceId: "second" });
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
  const connection = await dial(track, listener);
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

it("interruption: a call its caller cancels is interrupted on the host, its handler's signal aborted", async () => {
  const track = trackTest;
  const { listener, seen } = await listen(track);
  const connection = await dial(track, listener);
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
  const connection = await dial(track, listener, { onClose: () => closes++ });
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
  await dial(track, listener, { onClose: () => (firstClosed = true) });
  const second = await dial(track, listener);
  await waitFor(() => firstClosed, "the first link to end");
  assert.deepEqual(await invoke(second, "git:sweep"), { leaseMs: 5 });
});

it("tabs: a web device holds a link per tab, each hears its own pushes, and one closing leaves the other", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  listener.setAccepts(true);
  let firstClosed = false;
  const first = await dial(track, listener, {
    deviceKind: "web",
    onClose: () => (firstClosed = true),
  });
  const second = await dial(track, listener, { deviceKind: "web" });
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
  assert.deepEqual(await invoke(second, "git:sweep"), { leaseMs: 5 });
});

it("tabs: a hello with a connection id already held replaces that link alone", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  const tab = { deviceKind: "web" as const, connectionId: "a".repeat(32) };
  const stale = await rawLink(track, listener);
  assert.ok(Exit.isSuccess(await stale.hello(PROTOCOL_VERSION, tab)));
  let siblingClosed = false;
  await dial(track, listener, {
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

it("stop: the listener stopping closes every link, and nothing answers after", async () => {
  const track = trackTest;
  const { listener } = await listen(track);
  let closed = false;
  await dial(track, listener, { onClose: () => (closed = true) });
  await listener.binding.reconcile(null);
  await waitFor(() => closed, "the link to close");
  const after = await dialFails(listener);
  assert.equal(after.blocked, false);
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
    await Effect.runPromiseExit(Stream.runCollect(raw.watch("scripts:watch"))),
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
    raw.call("git:sweep").pipe(
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
  for (const module of [...allContractModules, controlContract]) {
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
  // Spot-check the load-bearing decisions so a silent flip is caught.
  assert.equal(annotation(callOf(runtimeContract, "nuke"), Remote), false);
  // A peer may relocate the data folder, but only as a command.
  assert.equal(
    annotation(callOf(runtimeContract, "moveDataDir"), Remote),
    true,
  );
  assert.equal(annotation(callOf(runtimeContract, "moveDataDir"), Gated), true);
  // info is the one runtime call a peer may make: the project pages
  // under a device twin spell worktree paths off its data dir. It
  // rides the command grant like the fs reads, since it names the
  // host's paths.
  assert.equal(annotation(callOf(runtimeContract, "info"), Remote), true);
  assert.equal(annotation(callOf(runtimeContract, "info"), Gated), true);
  assert.equal(annotation(callOf(launchersContract, "launch"), Remote), false);
  // The cli module rides the wire wholly behind the grant: even
  // its status reads name host paths, so none of it is ungated.
  for (const call of callsOf(cliContract)) {
    assert.equal(annotation(call, Remote), true);
    assert.equal(annotation(call, Gated), true);
  }
  assert.equal(annotation(callOf(globalConfigContract, "read"), Remote), true);
  assert.equal(annotation(callOf(worktreesContract, "create"), Remote), true);
  // Spot-check the mutating classification so a read cannot silently
  // become a command (served ungated to every peer) or a command a
  // read (served ungated too).
  assert.equal(annotation(callOf(worktreesContract, "create"), Gated), true);
  assert.equal(annotation(callOf(worktreesContract, "list"), Gated), false);
  assert.equal(annotation(callOf(worktreesContract, "push"), Gated), true);
  assert.equal(annotation(callOf(scriptsContract, "run"), Gated), true);
  assert.equal(annotation(callOf(gitContract, "refreshProject"), Gated), true);
  // The sweep is the host's own scheduled pass. A peer's request
  // only decides when it runs, so it is read-class despite the git
  // and gh it spawns.
  assert.equal(annotation(callOf(gitContract, "sweep"), Gated), false);
  assert.equal(annotation(callOf(globalConfigContract, "read"), Gated), false);
  // The step-6 flips (v2 slice B). Every fs call is remote AND
  // gated: they read, but they disclose arbitrary absolute
  // paths, so they ride the command grant rather than the ungated
  // read set.
  for (const key of [
    "listDirectory",
    "scanForGitRepos",
    "isGitRepo",
  ] as const) {
    assert.equal(
      annotation(callOf(fsContract, key), Remote),
      true,
      `fs.${key} remote`,
    );
    assert.equal(
      annotation(callOf(fsContract, key), Gated),
      true,
      `fs.${key} must require the command grant`,
    );
  }
  // The projects registry writes and the packageScripts preference
  // write are commands on the remote surface now.
  for (const key of ["add", "remove", "reorder"] as const) {
    assert.equal(
      annotation(callOf(projectsContract, key), Remote),
      true,
      `projects.${key} remote`,
    );
    assert.equal(
      annotation(callOf(projectsContract, key), Gated),
      true,
      `projects.${key} mutating`,
    );
  }
  assert.equal(
    annotation(callOf(packageScriptsContract, "setSort"), Remote),
    true,
  );
  assert.equal(
    annotation(callOf(packageScriptsContract, "setSort"), Gated),
    true,
  );
  // The sync surface a peer drives: every call is a command, so the
  // whole transfer path rides the command grant. The source links
  // (openSource, receiveWorktree, receiveBundle) are the only way
  // commits cross, bytes on a channel the grant already gates.
  for (const key of [
    "ignoredPaths",
    "worktreeFolder",
    "hasCommits",
    "openSource",
    "receiveWorktree",
    "receiveBundle",
    "cancelMove",
  ] as const) {
    assert.equal(
      annotation(callOf(syncContract, key), Remote),
      true,
      `sync.${key} remote`,
    );
    assert.equal(
      annotation(callOf(syncContract, key), Gated),
      true,
      `sync.${key} must require the command grant`,
    );
  }
  // The byte-stream opens (step 8, reworked onto channels): both
  // are grant-gated commands. The bytes themselves ride binary
  // channel frames, never invokes.
  for (const [name, call] of [
    ["forward.open", callOf(forwardContract, "open")],
    ["mirror.openStream", callOf(mirrorContract, "openStream")],
  ] as const) {
    assert.equal(annotation(call, Remote), true, `${name} remote`);
    assert.equal(
      annotation(call, Gated),
      true,
      `${name} must require the command grant`,
    );
  }
  // The move orchestrators and the teardown are LOCAL-only: a
  // device's own renderer drives them, and they must never be
  // servable to a peer -- a remote:false host invoke is simply not
  // registered on the direct listener. What a peer drives is the
  // landing half above, which rides the command grant.
  for (const name of [
    "pullWorktree",
    "sendWorktree",
    "teardownSource",
  ] as const) {
    assert.equal(annotation(callOf(syncContract, name), Remote), false);
    assert.equal(annotation(callOf(syncContract, name), Gated), true);
  }
  // The pull's progress frames go back to the invoking renderer
  // only: an untagged broadcast never reaches a remote wire.
  assert.notEqual(
    annotation(callOf(syncContract, "pullProgress"), Remote),
    true,
  );
  // The command-access switch reaches peers as a push carrying it:
  // the one client-scoped broadcast tagged remote. The switch's
  // read and write stay client-scoped and untagged, so neither is
  // ever served to a peer.
  const commandAccessChanged = callOf(accountContract, "commandAccessChanged");
  assert.equal(scopeOf(accountContract), "client");
  assert.equal(annotation(commandAccessChanged, Remote), true);
  assert.equal(safeDecode(payloadOf(commandAccessChanged), true).success, true);
  for (const key of ["acceptsCommands", "setAcceptsCommands"] as const) {
    assert.notEqual(annotation(callOf(accountContract, key), Remote), true);
  }
  // The device-settings write, the only settings write: a command,
  // and its STRICT patch schema must reject every key the Settings
  // form does not manage, so a peer cannot stop this device serving
  // peers or point it at another connector binary. The rejection is
  // structural (unknown key -> parse error), not a strip.
  const writeDeviceSettings = callOf(
    globalConfigContract,
    "writeDeviceSettings",
  );
  assert.equal(annotation(writeDeviceSettings, Remote), true);
  assert.equal(annotation(writeDeviceSettings, Gated), true);
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

it("golden read surface: the ungated read channels match read-surface.golden.json", async () => {
  // The spot-checks above prove chosen tags, but nothing proved the
  // WHOLE read/mutate axis: a single gated:true flipped to false
  // would serve that channel ungated to any account peer with the
  // battery still green. Pinning the full ungated surface in a
  // committed golden file turns any such flip into a reviewed diff.
  const goldenPath = join(import.meta.dirname, "read-surface.golden.json");
  const derived = allContractModules
    .filter((module) => scopeOf(module) === "host")
    .flatMap((module) => callsOf(module))
    .filter(
      (call) =>
        !isBroadcast(call) &&
        annotation(call, Remote) === true &&
        annotation(call, Gated) === false,
    )
    .map((call) => channelOf(call))
    .toSorted();
  // `-u` rewrites the golden from the derived surface. Otherwise a
  // mismatch fails with the channels that drifted, named against the
  // committed file.
  const golden: string[] = existsSync(goldenPath)
    ? JSON.parse(readFileSync(goldenPath, "utf8"))
    : [];
  const goldenSet = new Set(golden);
  const derivedSet = new Set(derived);
  const opened = derived.filter((channel) => !goldenSet.has(channel));
  const closed = golden.filter((channel) => !derivedSet.has(channel));
  await expect(
    `${JSON.stringify(derived, null, 2)}\n`,
    [
      "the ungated read surface drifted from test/read-surface.golden.json",
      ...opened.map((channel) => `  now servable ungated: ${channel}`),
      ...closed.map((channel) => `  no longer servable:   ${channel}`),
      "if the change is deliberate, regenerate with: pnpm test socket-host -u",
    ].join("\n"),
  ).toMatchFileSnapshot(goldenPath);
});
