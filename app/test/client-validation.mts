// What a client's link makes of a far end on another build
// (shared/remote/rpcTransport.ts, rpcLink). Its RpcClient decodes every
// answer, push and view value with the call's schema, so a malformed
// answer fails the call and a malformed view value ends the view, each
// naming the call, and a malformed push is dropped while the next still
// lands. The calls cross a real wire: a probe module served the way the
// shell serves a window (main/ipc/ShellLink.ts), by this build and by
// "another build" whose answer's schema differs, called by this build's
// link over a port (shared/remote/portLink.ts), serialized as every
// wire is. That server carries no views, and a wire's push of another
// build never decodes at all, so the push and the view meet the
// RpcClient's own refusal (its decode dying with a SchemaError) from a
// client standing in for it, as does a request the socket couldn't
// write, which is the link gone and not the call's failure.
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { afterEach, it } from "vitest";
import { makePortServer } from "../main/ipc/ShellLink";
import { createShellRegistrar } from "../main/ipc/shellRegistrar";
import { portLink } from "@shared/remote/portLink";
import type { PortEnds } from "@shared/remote/portSocket";
import {
  type FlatClient,
  RemoteDisconnectedError,
  rpcLink,
  UnreadableAnswerError,
} from "@shared/remote/rpcTransport";
import { waitFor } from "./lib/checkKit.mts";

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

// A link over a client that answers as the RpcClient does with a value
// it cannot decode: its decode dies with the SchemaError.
async function linkOver(client: FlatClient) {
  return Effect.runPromise(
    rpcLink({ client, group: thisBuild }).pipe(Scope.provide(newScope())),
  );
}

const decodedAs =
  <S extends Schema.Top>(schema: S) =>
  (value: unknown) =>
    Effect.orDie(Schema.decodeUnknownEffect(schema)(value));

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  const failure = Exit.isFailure(exit)
    ? Option.getOrUndefined(Exit.findErrorOption(exit))
    : undefined;
  assert.ok(failure !== undefined, `expected a failure, got ${exit}`);
  return failure;
};

it("an answer this build reads passes, a malformed one fails the call naming it", async () => {
  const good = await linkTo(thisBuild, 2);
  assert.deepEqual(
    await Effect.runPromise(good.call("probe:count", undefined)),
    { count: 2 },
  );
  const bad = await linkTo(otherBuild, "two");
  const failure = failureOf(
    await Effect.runPromiseExit(bad.call("probe:count", undefined)),
  );
  assert.ok(failure instanceof UnreadableAnswerError);
  assert.equal(
    failure.message,
    "probe:count answered in a shape this build does not read",
  );
});

it("a malformed push is dropped and the next one still lands", async () => {
  // The link's first subscription hears a malformed push; what the
  // channel says after it comes on the next.
  const later = await Effect.runPromise(Queue.unbounded<unknown>());
  let subscriptions = 0;
  const link = await linkOver((tag) =>
    tag === "probe:ticked"
      ? Stream.suspend(() =>
          (subscriptions++ === 0
            ? Stream.make({ at: "late" })
            : Stream.fromQueue(later)
          ).pipe(
            Stream.mapEffect(decodedAs(Schema.Struct({ at: Schema.Int }))),
          ),
        )
      : Stream.never,
  );
  await waitFor(() => subscriptions === 2, "the channel heard again");
  const seen: unknown[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(link.pushes("probe:ticked"), (value) =>
      Effect.sync(() => seen.push(value)),
    ),
  );
  // Said until heard: the reader joins the fan-out on its own time.
  await waitFor(() => {
    Queue.offerUnsafe(later, { at: 3 });
    return seen.length > 0;
  }, "a push after it landed");
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.deepEqual(seen[0], { at: 3 });
});

it("a malformed view value ends the view naming it, after the values before it", async () => {
  const link = await linkOver((tag) =>
    tag === "probe:watch"
      ? Stream.fromIterable([{ n: 1 }, { n: "two" }, { n: 3 }]).pipe(
          Stream.mapEffect(decodedAs(Schema.Struct({ n: Schema.Int }))),
        )
      : Stream.never,
  );
  const seen: unknown[] = [];
  const exit = await Effect.runPromiseExit(
    Stream.runForEach(link.view("probe:watch", { from: 0 }), (value) =>
      Effect.sync(() => seen.push(value)),
    ),
  );
  assert.deepEqual(seen, [{ n: 1 }]);
  const failure = failureOf(exit);
  assert.ok(failure instanceof UnreadableAnswerError);
  assert.equal(failure.channel, "probe:watch");
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
