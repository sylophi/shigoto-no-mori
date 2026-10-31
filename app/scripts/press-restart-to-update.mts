#!/usr/bin/env bun
// Settings' "Restart to update", from outside the window: dials the
// running app's loopback as its windows do (the port and token
// loopback.json holds) and makes the same call the button's mutation
// makes, `updater:install`. A signed build takes no debugger, so this
// is how a script presses the button of a signed one
// (scripts/smoke-app.mts). Its hello carries this checkout's
// PROTOCOL_VERSION, which an app at another protocol refuses. Prints
// the call's outcome as one JSON line: {"answer": ...} or
// {"failed": "<message>"}.
//
//   bun scripts/press-restart-to-update.mts <data dir>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { LoopbackGroup } from "@shigomori/contracts/link";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import { LOOPBACK_FILE, LoopbackFile } from "@shigomori/engine/Control";
import {
  flatClient,
  newConnectionId,
  quietProtocol,
} from "@shigomori/engine/rpcClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

const dataDir = process.argv[2];
if (dataDir === undefined) {
  console.error("usage: press-restart-to-update.mts <data dir>");
  process.exit(2);
}
const { port, token } = Schema.decodeSync(LoopbackFile)(
  readFileSync(join(dataDir, LOOPBACK_FILE), "utf8"),
);

const press = Effect.gen(function* () {
  const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}`);
  const client = yield* flatClient(LoopbackGroup, yield* quietProtocol(socket));
  const call = (tag: string, payload: unknown) =>
    client(tag, payload) as Effect.Effect<unknown, unknown>;
  yield* call("link:hello", {
    deviceId: newConnectionId(),
    deviceKind: "desktop",
    connectionId: newConnectionId(),
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
