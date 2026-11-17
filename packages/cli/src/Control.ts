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
import {
  callsOf,
  channelOf,
  type ContractModule,
  isInvoke,
  keyOf,
  moduleOf,
  versionOf,
} from "@shigomori/contracts/contract";
import {
  CLOSE_TRY_AGAIN,
  LOOPBACK_FILE,
  LoopbackFile,
  LoopbackGroup,
  outdatedModules,
  versionsOf,
} from "@shigomori/contracts/link";
import type { Welcome } from "@shigomori/contracts/modules/link";
import {
  CONTROL_ERROR_CODES,
  isControlErrorCode,
} from "@shigomori/contracts/modules/control";
import { CORE_VERSION } from "@shigomori/contracts/protocol";
import type {
  EffectClient,
  ViewInput,
  ViewKeys,
  ViewValue,
} from "@shigomori/contracts/types";
import { type Flavor, flavorNames, isFlavor } from "@shigomori/engine/flavor";
import { answerWithin } from "@shigomori/engine/liveness";
import * as Paths from "@shigomori/engine/Paths";
import { byHostKind } from "@shigomori/engine/platform";
import { pidAlive } from "@shigomori/engine/processes";
import * as Registry from "@shigomori/engine/Registry";
import {
  flatClient,
  newConnectionId,
  quietProtocol,
} from "@shigomori/engine/rpcClient";
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

// Nothing answers at the address loopback.json names, or what answers
// isn't the app.
class AppNotRunning extends Schema.TaggedError<AppNotRunning>()(
  "AppNotRunning",
  { flavor: Schema.String.check(Schema.makeFilter(isFlavor)) },
) {
  override get message(): string {
    const bin = flavorNames(this.flavor).binaryName;
    return byHostKind({
      app: `The Shigoto no Mori app isn't running, and it is what reaches your other devices. ${
        this.flavor === "dev"
          ? "Start it with `pnpm dev` in a checkout, sign in, and try again."
          : `Open it (${bin} app), sign in, and try again.`
      }`,
      headless: `This machine's host isn't running, and it is what reaches your other devices. ${
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

// A view over the loopback is a transfer's: its progress, then its
// answer.
type Event =
  | { readonly _tag: "progress"; readonly progress: unknown }
  | { readonly _tag: "result"; readonly result: unknown };

type ProgressOf<A> = Extract<
  A,
  { readonly _tag: "progress"; readonly progress: unknown }
>["progress"];
type ResultOf<A> = Extract<
  A,
  { readonly _tag: "result"; readonly result: unknown }
>["result"];

// A module's invokes, each answered with its output, and its views,
// each answered with the transfer's result once `onProgress` has seen
// its progress.
type ControlClient<M extends ContractModule> = EffectClient<M, ControlError> & {
  readonly [K in ViewKeys<M>]: (
    input: ViewInput<M, K>,
    onProgress: (progress: ProgressOf<ViewValue<M, K>>) => Effect.Effect<void>,
  ) => Effect.Effect<ResultOf<ViewValue<M, K>>, ControlError>;
};

export class Control extends Context.Service<
  Control,
  {
    // A module's calls to the app, each over a fresh connection and
    // answered with what the RpcClient decoded against LoopbackGroup's
    // schema.
    readonly client: <M extends ContractModule>(module: M) => ControlClient<M>;
  }
>()("sm/cli/Control") {}

// The app answers a hello at once, so a dial or a welcome that takes
// this long, of turns this process ran through, is not the app. One
// this process was stopped for (a Ctrl-Z, a sleep) is asked again
// (answerWithin).
const HANDSHAKE_TIMEOUT_MS = 5_000;

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
    // A refusal before the welcome: a listener at its cap says so, and
    // anything else is a loopback.json this listener didn't write.
    const turnedAway = () =>
      closeCode === CLOSE_TRY_AGAIN
        ? new AppBusy({ binary: paths.binaryName })
        : notRunning;

    const hello = client("link:hello", {
      deviceId,
      // The loopback holds every caller apart, whatever it says.
      deviceKind: "desktop",
      connectionId: newConnectionId(),
      appVersion: paths.binaryName,
      protocolVersion: CORE_VERSION,
      token: file.token,
    }) as Effect.Effect<unknown, unknown>;
    const welcome = (yield* hello.pipe(
      Effect.mapError((error) =>
        isProtocolVersionMismatchError(error)
          ? skewed("link:hello", error.hostVersion < error.clientVersion)
          : turnedAway(),
      ),
    )) as Welcome;
    return {
      client,
      call: (tag: string, payload: unknown) =>
        client(tag, payload) as Effect.Effect<unknown, unknown>,
      // The modules this binary and the app hold at different versions.
      outdated: outdatedModules(versionsOf(LoopbackGroup), welcome.versions),
    };
  });
  type Link = Effect.Success<ReturnType<typeof connect>>;

  // The app and this binary are builds of different releases, on
  // different cores or with the call's module at different versions.
  // The older of the two is an app an update replaced and that never
  // restarted, or another copy of this binary first on PATH.
  const skewed = (channel: string, appOlder: boolean) =>
    new ControlRefused({
      channel,
      said: appOlder
        ? byHostKind({
            app: `The app running here is older than this ${paths.binaryName}. Restart it to update (quit it and open it again), and try again.`,
            headless: `The host running here is older than this ${paths.binaryName}. Restart it to update (\`${paths.binaryName} service restart\`), and try again.`,
          })
        : `This ${paths.binaryName} is older than the ${byHostKind({ app: "app", headless: "host" })} running here. Run \`${paths.binaryName} doctor\` to see the ${paths.binaryName} binaries on PATH.`,
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

  // One call over a fresh connection: `ask` over the link once the
  // handshake is through.
  const call = Effect.fn("Control.call")(function* <A>(
    channel: string,
    ask: (link: Link) => Effect.Effect<A, unknown>,
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
        const rpc = LoopbackGroup.requests.get(channel);
        if (
          rpc !== undefined &&
          link.outdated?.modules.includes(moduleOf(rpc)) === true
        ) {
          return yield* skewed(channel, link.outdated.outdated === "peer");
        }
        // A transfer takes as long as it takes, so the call is on no
        // clock.
        return yield* ask(link);
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

  const invoke = (channel: string) => (input?: unknown) =>
    call(channel, (link) => link.call(channel, input));

  const progressing =
    (channel: string) =>
    (input: unknown, onProgress: (progress: unknown) => Effect.Effect<void>) =>
      call(channel, (link) =>
        Effect.gen(function* () {
          let answer: unknown;
          yield* Stream.runForEach(
            link.client(channel, input) as Stream.Stream<Event, unknown>,
            (event) =>
              "progress" in event
                ? onProgress(event.progress)
                : Effect.sync(() => {
                    answer = event.result;
                  }),
          );
          if (answer === undefined) return yield* new ConnectionLost();
          return answer;
        }),
      );

  const client = <M extends ContractModule>(module: M): ControlClient<M> => {
    const calls: Record<string, unknown> = {};
    for (const one of callsOf(module)) {
      const channel = channelOf(one);
      // Fails closed on a call the app of another release would take
      // unchecked.
      if (versionOf(one) === undefined) {
        throw new Error(`${channel} names no version for another build`);
      }
      calls[keyOf(one)] = isInvoke(one)
        ? invoke(channel)
        : progressing(channel);
    }
    // oxlint-disable-next-line shigomori/no-double-cast -- built from the module's own calls, each answering as its call
    return calls as unknown as ControlClient<M>;
  };

  return Control.of({ client });
});

export const layer = (flavor: Flavor) =>
  Layer.effect(Control, make(flavor)).pipe(
    // Node's and Bun's own WebSocket, the one client both have.
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
