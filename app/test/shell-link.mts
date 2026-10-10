// Durable proof for the window's link to its shell: Effect RPC over a
// MessagePort, the window's end (shared/ipc/shell.ts) against the
// shell's (main/ipc/shellLink.ts), on node's own ports. Asserted: a
// value crosses as it is, a contract error comes back as its class with
// its fields, any other failure as a plain Error with its message, a
// push to every window reaches each, a push to one window reaches that
// one alone, and a port that closes aborts its calls' connection.
//
// Run: pnpm test shell-link.
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  BranchNotMergedError,
  isBranchNotMergedError,
} from "@shigomori/contracts/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, it } from "vitest";
import {
  createShellRegistrar,
  layer,
  ShellLink,
  type ShellRegistrar,
} from "../main/ipc/shellLink";
import * as FiberSet from "effect/FiberSet";
import { shellLink } from "@shared/ipc/shell";
import { linkTransport } from "@shared/remote/rpcTransport";
import type { HandlerContext } from "@shared/ipc/transport";

const ADDRESS = {
  port: 62_814,
  token: "a".repeat(32),
  deviceId: "20007c1a-3639-4b52-b39f-92b19bcccc0d",
};

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one link down at a time
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
    // oxlint-disable-next-line no-await-in-loop -- polling
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
      close: () => port2.close(),
    };
  };
  return { link, open };
}

it("a value crosses as it is", async () => {
  const registrar = createShellRegistrar();
  registrar.handle("window:hostAddress", async () => ADDRESS);
  const { open } = await serve(registrar);
  const { transport } = await open();
  assert.deepEqual(
    await transport.invoke("window:hostAddress", undefined),
    ADDRESS,
  );
});

it("a contract error comes back as its class, fields and message", async () => {
  const registrar = createShellRegistrar();
  registrar.handle("window:hostAddress", async () => {
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
  registrar.handle("window:hostAddress", async () => {
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
    registrar.broadcastAll("window:focused", undefined);
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
  registrar.handle("window:hostAddress", async (ctx: HandlerContext) => {
    connection = ctx.connection;
    return ADDRESS;
  });
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
