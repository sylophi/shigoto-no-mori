#!/usr/bin/env bun
// Settings' "Restart to update", from outside the window: dials the
// running app's loopback as its windows do (the port and token
// loopback.json holds) and makes the same call the button's mutation
// makes, `updater:install`. A packaged build takes no debugger, so this
// is how a script presses the button of a signed one
// (scripts/smoke-app.mts). Prints the call's outcome as one JSON line:
// {"answer": ...} or {"failed": "<message>"}.
//
//   bun scripts/press-restart-to-update.mts <data dir>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { LINK_MAX_FRAME_BYTES, LoopbackGroup } from "@shigomori/contracts/link";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

const dataDir = process.argv[2];
if (dataDir === undefined) {
  console.error("usage: press-restart-to-update.mts <data dir>");
  process.exit(2);
}
const { port, token } = JSON.parse(
  readFileSync(join(dataDir, "loopback.json"), "utf8"),
) as { port: number; token: string };

const hex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const press = Effect.gen(function* () {
  const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}`);
  const protocol = yield* RpcClient.makeProtocolSocket({
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provide(
      RpcSerialization.layerSchemaBinary({
        maxFrameSize: LINK_MAX_FRAME_BYTES,
      }),
    ),
  );
  // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
  const call = (yield* RpcClient.make(LoopbackGroup, { flatten: true }).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )) as unknown as (tag: string, payload: unknown) => Effect.Effect<unknown>;
  yield* call("link:hello", {
    deviceId: hex(),
    deviceKind: "desktop",
    connectionId: hex(),
    appVersion: "press-restart-to-update",
    protocolVersion: PROTOCOL_VERSION,
    token,
  });
  return yield* call("updater:install", undefined);
}).pipe(
  Effect.scoped,
  Effect.provide(Socket.layerWebSocketConstructorGlobal),
  Effect.matchCause({
    onSuccess: (answer) => ({ answer: answer ?? null }),
    onFailure: (cause) => ({ failed: errorMessageOf(Cause.squash(cause)) }),
  }),
);

console.log(JSON.stringify(await Effect.runPromise(press)));
