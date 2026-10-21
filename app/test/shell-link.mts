// Durable proof for the window's link to its shell: Effect RPC over a
// MessagePort, the window's end (shared/ipc/shell.ts) against the
// shell's (main/ipc/ShellLink.ts), on node's own ports. Asserted: a
// value crosses as it is, a contract error comes back as its class with
// its fields, any other failure as a plain Error with its message, a
// push to every window reaches each, a push to one window reaches that
// one alone, a port that closes aborts its calls' connection, and a
// link that heard nothing for an hour, then slept, still answers, the
// window's and the host's alike (EFFECT.md, section 8).
//
// Run: pnpm test shell-link.
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  BranchNotMergedError,
  isBranchNotMergedError,
} from "@shigomori/contracts/errors";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { windowContract } from "@shigomori/contracts/modules/window";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as Exit from "effect/Exit";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, it, vi } from "vitest";
import { log } from "@shared/log";
import { sleepingClock, testClock } from "./lib/checkKit.mts";
import {
  layer,
  makePortServer,
  ShellLink,
  type ShellRegistrar,
} from "../main/ipc/ShellLink";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import { portLink } from "@shared/remote/portLink";
import { createShellRegistrar } from "../main/ipc/shellRegistrar";
import * as FiberSet from "effect/FiberSet";
import { shellLink } from "@shared/ipc/shell";
import {
  linkTransport,
  RemoteDisconnectedError,
} from "@shared/remote/rpcTransport";
import type { HandlerContext, Link } from "@shared/ipc/transport";
import * as Stream from "effect/Stream";

const ADDRESS = {
  port: 62_814,
  token: "a".repeat(32),
  deviceId: "20007c1a-3639-4b52-b39f-92b19bcccc0d",
};

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

// MessagePortMain's surface (main's end) over a node port.
const asMainPort = (port: MessagePort) => ({
  postMessage: (data: unknown) => port.postMessage(data),
  close: () => port.close(),
  on: (event: "message" | "close", fn: (value: unknown) => void) =>
    event === "message"
      ? port.on("message", (data: unknown) => fn({ data }))
      : port.on("close", fn),
  start: () => port.start(),
});

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function serve(registrar: ShellRegistrar) {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  const link = Context.get(
    await Effect.runPromise(Layer.buildWithScope(layer(registrar), scope)),
    ShellLink,
  );
  // A window: its port, and what main knows it by.
  const open = async (webContents: object = {}) => {
    const { port1, port2 } = new MessageChannel();
    await Effect.runPromise(
      link.attach(asMainPort(port1) as never, webContents as never),
    );
    const transport = await Effect.runPromise(
      Effect.gen(function* () {
        const runFork = yield* FiberSet.makeRuntime<never>();
        return linkTransport(yield* shellLink(port2 as never), runFork);
      }).pipe(Scope.provide(scope)),
    );
    return {
      transport,
      // The window's end, for a frame no link would send.
      port: port2,
      close: () => port2.close(),
    };
  };
  return { link, open };
}

it("a value crosses as it is", async () => {
  const registrar = createShellRegistrar();
  registrar.serveOne(windowContract, "hostAddress", async () => ADDRESS);
  const { open } = await serve(registrar);
  const { transport } = await open();
  assert.deepEqual(
    await transport.invoke("window:hostAddress", undefined),
    ADDRESS,
  );
});

it("a contract error comes back as its class, fields and message", async () => {
  const registrar = createShellRegistrar();
  registrar.serveOne(windowContract, "hostAddress", async () => {
    throw new BranchNotMergedError({ branch: "feat/x" });
  });
  const { open } = await serve(registrar);
  const { transport } = await open();
  await assert.rejects(
    transport.invoke("window:hostAddress", undefined),
    (error: unknown) =>
      isBranchNotMergedError(error) &&
      error.branch === "feat/x" &&
      error.message === "Branch 'feat/x' has unmerged commits.",
  );
});

it("any other failure comes back as a plain Error with its message", async () => {
  const registrar = createShellRegistrar();
  registrar.serveOne(windowContract, "hostAddress", async () => {
    throw new Error("boom");
  });
  const { open } = await serve(registrar);
  const { transport } = await open();
  await assert.rejects(
    transport.invoke("window:hostAddress", undefined),
    (error: unknown) =>
      error instanceof Error &&
      !isBranchNotMergedError(error) &&
      error.message === "boom",
  );
});

it("a push to every window reaches each, and one to a window that one alone", async () => {
  const registrar = createShellRegistrar();
  const { link, open } = await serve(registrar);
  const firstContents = {};
  const first = await open(firstContents);
  const second = await open();
  const heard = { first: new Set<string>(), second: new Set<string>() };
  first.transport.subscribe("window:focused", () => heard.first.add("all"));
  second.transport.subscribe("window:focused", () => heard.second.add("all"));
  first.transport.subscribe("window:blurred", () => heard.first.add("own"));
  second.transport.subscribe("window:blurred", () => heard.second.add("own"));

  // Each window subscribes as its link opens, in a fiber of its own: a
  // push that goes before that is lost, so it is sent until heard.
  await until(() => {
    PubSub.publishUnsafe(registrar.pushes, {
      channel: "window:focused",
      payload: undefined,
    });
    return heard.first.has("all") && heard.second.has("all");
  });
  await until(() => {
    Effect.runSync(
      link.pushTo(firstContents as never, {
        channel: "window:blurred",
        payload: undefined,
      }),
    );
    return heard.first.has("own");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(heard.second.has("own"), false);
});

it("a port that closes aborts its calls' connection", async () => {
  const registrar = createShellRegistrar();
  let connection: AbortSignal | undefined;
  registrar.serveOne(
    windowContract,
    "hostAddress",
    async (_input: void, ctx: HandlerContext) => {
      connection = ctx.connection;
      return ADDRESS;
    },
  );
  const { open } = await serve(registrar);
  const window = await open();
  await window.transport.invoke("window:hostAddress", undefined);
  assert.equal(connection?.aborted, false);
  window.close();
  await new Promise((resolve) => {
    if (connection?.aborted === true) resolve(undefined);
    connection?.addEventListener("abort", resolve);
  });
  assert.equal(connection?.aborted, true);
});

// An idle hour, the pings answered and nothing else heard, then a
// night's sleep, each with the next turn of every timer after it.
function throughTime(clock: ReturnType<typeof testClock>) {
  const { wall, sleep } = sleepingClock(clock);
  const passes = async () => {
    await clock.advance(60 * 60_000);
    sleep(8 * 60 * 60_000);
    await clock.advance(60 * 60_000);
  };
  return { wall, passes };
}

it("the window's link that heard nothing for an hour, then slept, still answers", async () => {
  const registrar = createShellRegistrar();
  registrar.serveOne(windowContract, "hostAddress", async () => ADDRESS);
  const { link } = await serve(registrar);
  const clock = testClock();
  const { wall, passes } = throughTime(clock);
  const { port1, port2 } = new MessageChannel();
  await Effect.runPromise(link.attach(asMainPort(port1) as never, {} as never));
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  const transport = await Effect.runPromise(
    Effect.gen(function* () {
      const runFork = yield* FiberSet.makeRuntime<never>();
      return linkTransport(yield* shellLink(port2 as never), runFork);
    }).pipe(Effect.provideService(Clock.Clock, wall), Scope.provide(scope)),
  );
  assert.deepEqual(
    await transport.invoke("window:hostAddress", undefined),
    ADDRESS,
  );
  await passes();
  assert.deepEqual(
    await transport.invoke("window:hostAddress", undefined),
    ADDRESS,
  );
});

it("the host's link to its shell, likewise, and each call runs once", async () => {
  const registrar = createShellRegistrar();
  let checks = 0;
  registrar.serveOne(shellCallsContract, "updaterCheck", async () => {
    checks += 1;
  });
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  const server = await Effect.runPromise(
    makePortServer(registrar, ShellCallsGroup).pipe(Scope.provide(scope)),
  );
  const { port1, port2 } = new MessageChannel();
  await Effect.runPromise(server.attach(asMainPort(port1) as never, null));
  const clock = testClock();
  const { wall, passes } = throughTime(clock);
  const shell = await Effect.runPromise(
    Effect.gen(function* () {
      const runFork = yield* FiberSet.makeRuntime<never>();
      const hostEnd = yield* portLink(
        {
          postMessage: (data) => port2.postMessage(data.slice()),
          close: () => port2.close(),
          listen: (onMessage, onClose) => {
            port2.on("message", onMessage);
            port2.on("close", onClose);
            port2.start();
          },
        },
        ShellCallsGroup,
      );
      return linkTransport(hostEnd, runFork);
    }).pipe(Effect.provideService(Clock.Clock, wall), Scope.provide(scope)),
  );
  await shell.invoke("shellCalls:updaterCheck", undefined);
  await passes();
  await shell.invoke("shellCalls:updaterCheck", undefined);
  assert.equal(checks, 2);
});

// A transport over a link whose every call is `call`.
const transportOver = (call: Link["call"]) =>
  linkTransport(
    { call, view: () => Stream.never, pushes: () => Stream.never },
    (effect) => Effect.runFork(effect),
  );

it("a call its link's scope cut reads as the link gone, and one its caller aborted as cancelled", async () => {
  // Interrupted with no abort: what a session closing under its calls does.
  await assert.rejects(
    transportOver(() => Effect.interrupt).invoke(
      "window:hostAddress",
      undefined,
    ),
    (error) => error instanceof RemoteDisconnectedError,
  );
  const aborted = new AbortController();
  const asked = transportOver(() => Effect.never).invoke(
    "window:hostAddress",
    undefined,
    { signal: aborted.signal },
  );
  aborted.abort();
  await assert.rejects(asked, /the call was cancelled/);
});

it("drops messages it can't read, says so without their bytes, and answers the port's next call", async () => {
  const registrar = createShellRegistrar();
  registrar.serveOne(windowContract, "hostAddress", async () => ADDRESS);
  const { open } = await serve(registrar);
  const { transport, port } = await open();
  const warned = vi.spyOn(log, "warn");
  const secret = new TextEncoder().encode("secret-token");
  const ping = SchemaBinary.encoder(RpcMessage.EncodedSchema, {
    fingerprint: true,
  }).encode({ _tag: "Ping" });
  try {
    // A length past any frame the link takes, a frame cut short, and a
    // good frame followed by a bad one.
    port.postMessage(new Uint8Array([0xff, 0xff, 0xff, 0x7f, ...secret]));
    port.postMessage(new Uint8Array([50, ...secret]));
    port.postMessage(new Uint8Array([...ping, 0xff, 0xff, 0xff, 0x7f]));
    assert.deepEqual(
      await transport.invoke("window:hostAddress", undefined),
      ADDRESS,
    );
    await until(() => warned.mock.calls.length >= 3);
    const said = warned.mock.calls.map((call) => String(call[0]));
    assert.deepEqual(
      said.map(
        (line) => /window port \((\d+) bytes: [^\n]+\)$/.exec(line)?.[1],
      ),
      ["16", "13", String(ping.length + 4)],
    );
    for (const line of said) assert.doesNotMatch(line, /secret-token/);
  } finally {
    warned.mockRestore();
  }
}, 10_000);
