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
  isHubRateLimitedError,
  isProtocolVersionMismatchError,
  LinkRefusedError,
  RemoteCallError,
} from "@shigomori/contracts/errors";
import { CLOSE_TRY_AGAIN, LoopbackGroup } from "@shigomori/contracts/link";
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
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { type Flavor, flavorNames, isFlavor } from "./flavor.ts";
import { byPlatform } from "./platform.ts";
import { answerWithin } from "./liveness.ts";
import * as Paths from "./Paths.ts";
import { pidAlive } from "./processes.ts";
import { flatClient, newConnectionId, quietProtocol } from "./rpcClient.ts";
import * as Registry from "./Registry.ts";

// Nothing answers at the address loopback.json names, or what answers
// isn't the app.
class AppNotRunning extends Schema.TaggedError<AppNotRunning>()(
  "AppNotRunning",
  { flavor: Schema.String.check(Schema.makeFilter(isFlavor)) },
) {
  override get message(): string {
    const bin = flavorNames(this.flavor).binaryName;
    return byPlatform({
      darwin: `The Shigoto no Mori app isn't running, and it is what reaches your other devices. ${
        this.flavor === "dev"
          ? "Start it with `pnpm dev` in a checkout, sign in, and try again."
          : `Open it (${bin} app), sign in, and try again.`
      }`,
      linux: `This machine's host isn't running, and it is what reaches your other devices. ${
        this.flavor === "dev"
          ? "Start it with `pnpm headless` in a checkout and try again."
          : `Start it (${bin} service start) and try again.`
      }`,
    });
  }

  get documentCode(): string {
    return "app-not-running";
  }
}

// The app is there, at its cap of connections.
class AppBusy extends Schema.TaggedError<AppBusy>()("AppBusy", {
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
class ConnectionLost extends Schema.TaggedError<ConnectionLost>()(
  "ConnectionLost",
  {},
) {
  override get message(): string {
    return "Lost the connection to the app before it answered. A transfer it had started is cancelled and rolled back. Anything else keeps running there: check the app, or `sm worktrees mirrors`.";
  }
}

// The account's hub turned the app's read of it away for a while.
class HubRateLimited extends Schema.TaggedError<HubRateLimited>()(
  "HubRateLimited",
  { retryAfterSeconds: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return this.retryAfterSeconds === undefined
      ? "Your account's hub is rate-limiting this device. Try again shortly."
      : `Your account's hub is rate-limiting this device. Try again in ${this.retryAfterSeconds} s.`;
  }

  get documentCode(): string {
    return "rate-limited";
  }
}

// The app turned the call down, in its own words and with its code.
class ControlRefused extends Schema.TaggedError<ControlRefused>()(
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
  | HubRateLimited
  | ControlRefused;

export class Control extends Context.Service<
  Control,
  {
    // One call over a fresh connection, answered with the result the
    // RpcClient decoded against LoopbackGroup's schema. `onPush` sees
    // each progress push the call streams to its caller before its
    // answer. An undefined input sends none.
    readonly call: (
      channel: string,
      input: unknown,
      onPush?: (channel: string, payload: unknown) => Effect.Effect<void>,
    ) => Effect.Effect<unknown, ControlError>;
  }
>()("sm/engine/Control") {}

export const LOOPBACK_FILE = "loopback.json";

// What loopback.json holds: the host's pid, the loopback's port and
// token, and the app's version. Written aside first, at
// loopbackPartialOf, and renamed in.
export const LoopbackFile = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    port: Schema.Int,
    token: Schema.String,
    appVersion: Schema.String,
  }),
);

export const loopbackPartialOf = (file: string, pid: number) =>
  `${file}.${pid}`;

// The app answers a hello at once, so a dial or a welcome that takes
// this long, of turns this process ran through, is not the app. One
// this process was stopped for (a Ctrl-Z, a sleep) is asked again
// (answerWithin).
const HANDSHAKE_TIMEOUT_MS = 5_000;

// What a transfer's progress is, to the verbs that show it.
const PROGRESS = "sync:pullProgress";

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
      Effect.flatMap(Schema.decodeUnknownEffect(LoopbackFile)),
      Effect.option,
      Effect.map(
        Option.filter(
          ({ pid, port, token }) => pid > 0 && port > 0 && token !== "",
        ),
      ),
    );

  // A connection to the listener, closed with the scope, and the link's
  // client over it once the handshake proved both ends hold the token.
  const connect = Effect.fn(function* (
    file: { readonly port: number; readonly token: string },
    deviceId: string,
  ) {
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
    );
    // One connection per call: a drop fails the call, as the answer. No
    // verdict from pings: the app is a process on this machine, whose
    // socket closes as it goes, and the app's own watchdog is what
    // judges a host that stops answering, closing this call's socket as
    // it starts another.
    const client = yield* flatClient(
      LoopbackGroup,
      yield* quietProtocol(socket),
    );
    const call = (tag: string, payload: unknown) =>
      client(tag, payload) as Effect.Effect<unknown, unknown>;
    // A refusal before the welcome: a listener at its cap says so, and
    // anything else is a loopback.json this listener didn't write.
    const turnedAway = () =>
      closeCode === CLOSE_TRY_AGAIN
        ? new AppBusy({ binary: paths.binaryName })
        : notRunning;

    yield* call("link:hello", {
      deviceId,
      // The loopback holds every caller apart, whatever it says.
      deviceKind: "desktop",
      connectionId: newConnectionId(),
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

  // A call's failure as the verbs read it. A refusal of commands is a
  // peer's (the loopback's callers pass no gate), and names the device
  // that refused: this one, when the peer had to reach back into it.
  const refusal = (
    channel: string,
    error: unknown,
    ownId: string,
  ): ControlError => {
    if (
      error instanceof AppNotRunning ||
      error instanceof AppBusy ||
      error instanceof ConnectionLost ||
      error instanceof HubRateLimited ||
      error instanceof ControlRefused
    ) {
      return error;
    }
    if (isHubRateLimitedError(error)) {
      return new HubRateLimited(
        error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds },
      );
    }
    if (error instanceof RemoteCallError) {
      return new ControlRefused({
        channel,
        ...(isControlErrorCode(error.code) ? { code: error.code } : {}),
        said: error.text,
      });
    }
    if (error instanceof LinkRefusedError) return notRunning;
    if (error instanceof CommandRefusedError) {
      return new ControlRefused({
        channel,
        said:
          error.deviceId === ownId
            ? `This device doesn't accept commands from your other devices, and the other one has to reach back into it for this. Turn it on (\`${paths.binaryName} devices control on\`) and try again.`
            : "The other device doesn't accept commands from this one. Turn on “Allow control from other devices” there (`devices control on` on Linux) and try again.",
      });
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
    const ownId = yield* registry.deviceId;
    const file = found.value;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Each try in a scope of its own, closed with its socket when
        // it is set aside, and the one that answered kept for the call.
        const attempt = Effect.gen(function* () {
          const scope = yield* Scope.make();
          return yield* connect(file, ownId).pipe(
            Scope.provide(scope),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
            ),
            Effect.map((connected) => ({ ...connected, scope })),
          );
        });
        const answered = yield* answerWithin(attempt, HANDSHAKE_TIMEOUT_MS);
        if (Option.isNone(answered)) return yield* notRunning;
        const link = yield* answered.value;
        yield* Effect.addFinalizer((exit) => Scope.close(link.scope, exit));
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
              : refusal(channel, Cause.squash(cause), ownId),
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
