// What a client's link (shared/remote/rpcTransport.ts, rpcLink) makes
// of an answer it can't read, and of a request its socket couldn't
// write. Its RpcClient decodes every answer with the call's schema, so
// a malformed one fails the call. The calls cross a real wire: a probe
// module served the way the shell serves a window
// (main/ipc/ShellLink.ts), by this build and by one whose answer's
// schema differs, called by this build's link over a port
// (shared/remote/portLink.ts), serialized as every wire is. A request
// the socket couldn't write, which is the link gone and not the call's
// failure, comes from a client standing in for the RpcClient.
//
// covers: app/shared/remote/rpcTransport.ts
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  defineContract,
  invoke,
  push,
  view,
} from "@shigomori/contracts/contract";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { afterEach, it } from "vitest";
import { makePortServer } from "../main/ipc/ShellLink";
import { createShellRegistrar } from "../main/ipc/shellRegistrar";
import { portLink } from "@shared/remote/portLink";
import type { PortEnds } from "@shared/remote/portSocket";
import type { FlatClient } from "@shigomori/engine/rpcClient";
import { RemoteDisconnectedError, rpcLink } from "@shared/remote/rpcTransport";

const READ = { remote: true, gated: false } as const;

const probeOn = <C extends Schema.Codec<unknown, unknown>>(count: C) =>
  defineContract(
    "probe",
    "client",
    invoke("count", Schema.Void, Schema.Struct({ count }), READ),
    push("ticked", Schema.Struct({ at: Schema.Int }), { remote: true }),
    view(
      "watch",
      Schema.Struct({ from: Schema.Int }),
      Schema.Struct({ n: Schema.Int }),
      READ,
    ),
  );

// This build counts in integers; the other in words.
const thisBuild = probeOn(Schema.Int);
const otherBuild = probeOn(Schema.String);

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

const newScope = () => {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  return scope;
};

// MessagePortMain's surface (the server's end) over a node port.
const asMainPort = (port: MessagePort) => ({
  postMessage: (data: unknown) => port.postMessage(data),
  close: () => port.close(),
  on: (event: "message" | "close", fn: (value: unknown) => void) =>
    event === "message"
      ? port.on("message", (data: unknown) => fn({ data }))
      : port.on("close", fn),
  start: () => port.start(),
});

const portEnds = (port: MessagePort): PortEnds => ({
  postMessage: (data) => port.postMessage(data.slice()),
  close: () => port.close(),
  listen: (onMessage, onClose) => {
    port.on("message", onMessage);
    port.on("close", onClose);
    port.start();
  },
});

// A server of `build` answering `count`, and this build's link to it.
async function linkTo(
  build: typeof thisBuild | typeof otherBuild,
  count: unknown,
) {
  const scope = newScope();
  const registrar = createShellRegistrar();
  registrar.serveOne(build as typeof thisBuild, "count", () => ({
    count: count as number,
  }));
  const server = await Effect.runPromise(
    makePortServer(registrar, build as never).pipe(Scope.provide(scope)),
  );
  const { port1, port2 } = new MessageChannel();
  await Effect.runPromise(server.attach(asMainPort(port1) as never, null));
  const link = await Effect.runPromise(
    portLink(portEnds(port2), thisBuild).pipe(Scope.provide(scope)),
  );
  return link;
}

// A link over a client standing in for the RpcClient.
async function linkOver(client: FlatClient) {
  return Effect.runPromise(
    rpcLink({ client, group: thisBuild }).pipe(Scope.provide(newScope())),
  );
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Exit.findErrorOption(exit))
    : undefined;
  assert.ok(failure !== undefined, `expected a failure, got ${exit}`);
  return failure;
};

it("an answer this build reads passes, and a malformed one fails the call", async () => {
  const good = await linkTo(thisBuild, 2);
  assert.deepEqual(
    await Effect.runPromise(good.call("probe:count", undefined)),
    { count: 2 },
  );
  const bad = await linkTo(otherBuild, "two");
  const exit = await Effect.runPromiseExit(bad.call("probe:count", undefined));
  assert.ok(
    Exit.isFailure(exit) && Schema.isSchemaError(Cause.squash(exit.cause)),
    `a malformed answer failed otherwise: ${exit}`,
  );
});

it("a request the socket couldn't write is the link gone, for a call and a view alike", async () => {
  // How the RpcClient raises a write that failed under it: a defect.
  const unwritten = new Socket.SocketError({
    reason: new Socket.SocketWriteError({ cause: new Error("EPIPE") }),
  });
  const link = await linkOver((tag) =>
    tag === "probe:watch"
      ? Stream.die(unwritten)
      : tag === "probe:count"
        ? Effect.die(unwritten)
        : Stream.never,
  );
  const viewed = await Effect.runPromiseExit(
    Stream.runDrain(link.view("probe:watch", { from: 0 })),
  );
  assert.ok(failureOf(viewed) instanceof RemoteDisconnectedError);
  const called = await Effect.runPromiseExit(
    link.call("probe:count", undefined),
  );
  assert.ok(failureOf(called) instanceof RemoteDisconnectedError);
});
