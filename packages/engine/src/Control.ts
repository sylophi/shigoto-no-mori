// How the cross-device verbs reach the running app. Another device is
// reached through the account, the hub socket and the one device link
// per peer, which the running app holds and a second process

// must not dial beside it, so these verbs ask the app.
//
// The app serves the device link a second time on loopback for the
// processes on this machine, and publishes it in <dataDir>/loopback.json:
// the port, and a token minted as the app starts, in an owner-only
// file. The hello carries the token: loopback traffic never leaves the
// machine, and the port comes from the same file.
import {
  CommandRefusedError,
  errorMessageOf,
  isProtocolVersionMismatchError,
  LinkRefusedError,
  RemoteCallError,
} from "@shigomori/contracts/errors";
import { LoopbackGroup } from "@shigomori/contracts/link";
import { isInvoke } from "@shigomori/contracts/contract";
import {
  CONTROL_ERROR_CODES,
  type ControlTransferEvent,
  isControlErrorCode,
} from "@shigomori/contracts/modules/control";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import type { Flavor } from "./flavor.ts";
import * as Paths from "./Paths.ts";
import { pidAlive } from "./processes.ts";
import * as Registry from "./Registry.ts";

// Nothing answers at the address loopback.json names, or what answers
// isn't the app.
export class AppNotRunning extends Schema.TaggedError<AppNotRunning>()(
  "AppNotRunning",
  { flavor: Schema.Literals(["prod", "dev"]) },
) {
  override get message(): string {
    const hint =
      this.flavor === "prod"
        ? "Open it (sm app), sign in, and try again."
        : "Start it with `pnpm dev` in a checkout, sign in, and try again.";
    return `The Shigoto no Mori app isn't running, and it is what reaches your other devices. ${hint}`;
  }

  get documentCode(): string {
    return "app-not-running";
  }
}

// The app is there, at its cap of connections.
export class AppBusy extends Schema.TaggedError<AppBusy>()("AppBusy", {
  binary: Schema.String,
}) {
  override get message(): string {
    return `The app is serving as many ${this.binary} commands as it takes at once. Try again in a moment.`;
  }

  get documentCode(): string {
    return "app-busy";
  }
}

// The connection went away after the call was sent.
export class ConnectionLost extends Schema.TaggedError<ConnectionLost>()(
  "ConnectionLost",
  {},
) {
  override get message(): string {
    return "Lost the connection to the app before it answered. A transfer it had started is cancelled and rolled back. Anything else keeps running there: check the app, or `sm worktrees mirrors`.";
  }
}

// The app turned the call down, in its own words and with its code.
export class ControlRefused extends Schema.TaggedError<ControlRefused>()(
  "ControlRefused",
  {
    channel: Schema.String,
    code: Schema.optional(Schema.Literals(CONTROL_ERROR_CODES)),
    said: Schema.String,
  },
) {
  override get message(): string {
    return this.said;
  }

  get documentCode(): string | undefined {
    return this.code;
  }
}

export type ControlError =
  | AppNotRunning
  | AppBusy
  | ConnectionLost
  | ControlRefused;

export class Control extends Context.Service<
  Control,
  {
    // One call over a fresh connection, answered with the result as the
    // app sent it. `onPush` sees each progress push the call streams to
    // its caller before its answer. An undefined input sends none.
    readonly call: (
      channel: string,
      input: unknown,
      onPush?: (channel: string, payload: unknown) => Effect.Effect<void>,
    ) => Effect.Effect<unknown, ControlError>;
  }
>()("sm/engine/Control") {}

export const LOOPBACK_FILE = "loopback.json";

// The app answers a hello at once, so a dial or a welcome that takes
// this long is not the app.
const HANDSHAKE_TIMEOUT = "5 seconds";

// The close code the link's listener turns a connection away with when
// it holds as many as it takes.
const CLOSE_OVER_CAPACITY = 1013;

// What a transfer's progress is, to the verbs that show it.
const PROGRESS = "sync:pullProgress";

const LoopbackFileSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.optional(Schema.Int),
    port: Schema.optional(Schema.Int),
    token: Schema.optional(Schema.String),
    appVersion: Schema.optional(Schema.String),
  }),
);

// The group's calls, each known only as some call: a tag and a payload,
// and an Effect or a Stream back.
type Flat = (
  tag: string,
  payload: unknown,
) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>;

const make = Effect.fn("Control.make")(function* (flavor: Flavor) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* Paths.Paths;
  const registry = yield* Registry.Registry;
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const notRunning = new AppNotRunning({ flavor });

  // The listener the app published, none when the file is missing,
  // unreadable or names nothing.
  const published = fs
    .readFileString(path.join(paths.dataDir, LOOPBACK_FILE))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LoopbackFileSchema)),
      Effect.option,
      Effect.map(
        Option.flatMap(({ pid = 0, port = 0, token = "", appVersion = "" }) =>
          pid > 0 && port > 0 && token !== ""
            ? Option.some({ pid, port, token, appVersion })
            : Option.none(),
        ),
      ),
    );

  // A connection to the listener, closed with the scope, and the link's
  // client over it once the handshake proved both ends hold the token.
  const connect = Effect.fn(function* (file: {
    readonly port: number;
    readonly token: string;
  }) {
    let closeCode: number | undefined;
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(() => {
          const ws = makeWebSocket(`ws://127.0.0.1:${file.port}`);
          ws.addEventListener("close", (event) => {
            closeCode = (event as { code?: number }).code;
          });
          return ws;
        }),
        (ws) => Effect.sync(() => ws.close(1000)),
      ),
      { openTimeout: HANDSHAKE_TIMEOUT },
    );
    // One connection per call: a drop fails the call, as the answer.
    const protocol = yield* RpcClient.makeProtocolSocket({
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerSchemaBinary()),
    );
    // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
    const client = (yield* RpcClient.make(LoopbackGroup, {
      flatten: true,
    }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    )) as unknown as Flat;
    const call = (tag: string, payload: unknown) =>
      client(tag, payload) as Effect.Effect<unknown, unknown>;
    // A refusal before the welcome: a listener at its cap says so, and
    // anything else is a loopback.json this listener didn't write.
    const turnedAway = () =>
      closeCode === CLOSE_OVER_CAPACITY
        ? new AppBusy({ binary: paths.binaryName })
        : notRunning;

    const deviceId = yield* registry.deviceId;
    yield* call("link:hello", {
      deviceId,
      // The loopback holds every caller apart, whatever it says.
      deviceKind: "desktop",
      connectionId: Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
      appVersion: paths.binaryName,
      protocolVersion: PROTOCOL_VERSION,
      token: file.token,
    }).pipe(
      Effect.mapError((error) =>
        isProtocolVersionMismatchError(error)
          ? new ControlRefused({ channel: "link:hello", said: error.message })
          : turnedAway(),
      ),
    );
    return { client, call };
  });

  // A call's failure as the verbs read it.
  const refusal = (channel: string, error: unknown): ControlError => {
    if (
      error instanceof AppNotRunning ||
      error instanceof AppBusy ||
      error instanceof ConnectionLost ||
      error instanceof ControlRefused
    ) {
      return error;
    }
    if (error instanceof RemoteCallError) {
      return new ControlRefused({
        channel,
        ...(isControlErrorCode(error.code) ? { code: error.code } : {}),
        said: error.text,
      });
    }
    if (
      error instanceof LinkRefusedError ||
      error instanceof CommandRefusedError
    ) {
      return notRunning;
    }
    if (Predicate.isTagged(error, "RpcClientError"))
      return new ConnectionLost();
    return new ControlRefused({ channel, said: errorMessageOf(error) });
  };

  const call = Effect.fn("Control.call")(function* (
    channel: string,
    input: unknown,
    onPush?: (pushed: string, payload: unknown) => Effect.Effect<void>,
  ) {
    const found = yield* published;
    // A file left by a crash names a dead pid, or a port nothing (or
    // something else) listens on: both read as not running, the second
    // through the dial or the handshake.
    if (Option.isNone(found) || !(yield* pidAlive(found.value.pid))) {
      return yield* notRunning;
    }
    const file = found.value;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const link = yield* connect(file).pipe(
          Effect.timeoutOrElse({
            duration: HANDSHAKE_TIMEOUT,
            orElse: () => Effect.fail(notRunning),
          }),
        );
        yield* Effect.logDebug(
          `control: connected to the app (v${file.appVersion}, pid ${file.pid})`,
        );
        // A transfer takes as long as it takes, so the call is on no
        // clock.
        const rpc = LoopbackGroup.requests.get(channel);
        if (rpc === undefined || isInvoke(rpc)) {
          return yield* link.call(channel, input);
        }
        // A transfer streams its progress, then its answer.
        let answer: unknown;
        yield* Stream.runForEach(
          link.client(channel, input) as Stream.Stream<
            ControlTransferEvent,
            unknown
          >,
          (event) =>
            "progress" in event
              ? (onPush?.(PROGRESS, event.progress) ?? Effect.void)
              : Effect.sync(() => {
                  answer = event.result;
                }),
        );
        if (answer === undefined) return yield* new ConnectionLost();
        return answer;
      }).pipe(
        // A call the app interrupted (it is quitting) is the app gone.
        // This fiber's own interruption, a Ctrl-C, still ends it.
        Effect.catchCause((cause) =>
          Effect.fail(
            Cause.hasInterruptsOnly(cause)
              ? new ConnectionLost()
              : refusal(channel, Cause.squash(cause)),
          ),
        ),
      ),
    );
  });

  return Control.of({ call });
});

export const layer = (flavor: Flavor) =>
  Layer.effect(Control, make(flavor)).pipe(
    // Node's and Bun's own WebSocket, the one client both have.
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
