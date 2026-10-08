// The control wire's client: how the cross-device verbs reach the
// running app. Another device is reached through the account, the hub
// socket and the one direct session per peer, which the running app
// holds and a second process must not dial beside it, so these verbs
// ask the app.
//
// The app publishes its listener in <dataDir>/control.json: a loopback
// port and a token minted at bind, in an owner-only file. The wire is
// newline-delimited JSON: hello with the token, then one `req`, answered
// by `push` lines (progress) and one `res`. Step 4 replaces it with the
// contracts' RPC client.
import { createConnection, type Socket } from "node:net";
import { kill } from "node:process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { Flavor } from "./flavor.ts";
import * as Paths from "./Paths.ts";

// Nothing answers at the address control.json names, or what answers
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
}

// The app is there, at its cap of connections.
export class AppBusy extends Schema.TaggedError<AppBusy>()("AppBusy", {
  binary: Schema.String,
}) {
  override get message(): string {
    return `The app is serving as many ${this.binary} commands as it takes at once. Try again in a moment.`;
  }
}

// The connection went away after the call was sent.
export class ConnectionLost extends Schema.TaggedError<ConnectionLost>()(
  "ConnectionLost",
  { channel: Schema.String },
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
    code: Schema.optional(Schema.String),
    said: Schema.String,
  },
) {
  override get message(): string {
    return this.said;
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
    // One request over a fresh connection, answered with the result as
    // the app sent it. `onPush` sees each push the handler streams
    // before its answer. An undefined input sends none.
    readonly call: (
      channel: string,
      input: unknown,
      onPush?: (channel: string, payload: unknown) => Effect.Effect<void>,
    ) => Effect.Effect<unknown, ControlError>;
  }
>()("sm/engine/Control") {}

const CONTROL_FILE = "control.json";

// The app answers a hello at once, so a dial or a welcome that takes
// this long is not the app.
const HANDSHAKE_TIMEOUT = "5 seconds";

const ControlFileSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.optional(Schema.Int),
    port: Schema.optional(Schema.Int),
    token: Schema.optional(Schema.String),
    appVersion: Schema.optional(Schema.String),
  }),
);

const FrameSchema = Schema.fromJsonString(
  Schema.Struct({
    t: Schema.optional(Schema.String),
    id: Schema.optional(Schema.Int),
    ok: Schema.optional(Schema.Boolean),
    result: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    channel: Schema.optional(Schema.String),
    payload: Schema.optional(Schema.Unknown),
  }),
);
type Frame = typeof FrameSchema.Type;

// Whether a process is there. One of another user's answers EPERM.
const pidAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      return Predicate.hasProperty(error, "code") && error.code === "EPERM";
    }
  });

// The lines a socket delivers, each whole, then undefined once it closed.
const splitLines = (socket: Socket, lines: Queue.Queue<string | undefined>) => {
  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const parts = `${partial}${chunk}`.split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) Queue.offerUnsafe(lines, line);
  });
  socket.on("close", () => Queue.offerUnsafe(lines, undefined));
};

const make = Effect.fn("Control.make")(function* (flavor: Flavor) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* Paths.Paths;
  const notRunning = new AppNotRunning({ flavor });

  // The listener the app published, none when the file is missing,
  // unreadable or names nothing.
  const published = fs
    .readFileString(path.join(paths.dataDir, CONTROL_FILE))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ControlFileSchema)),
      Effect.option,
      Effect.map(
        Option.flatMap(({ pid = 0, port = 0, token = "", appVersion = "" }) =>
          pid > 0 && port > 0 && token !== ""
            ? Option.some({ pid, port, token, appVersion })
            : Option.none(),
        ),
      ),
    );

  // A connection to the loopback port, closed with the scope: each
  // frame it reads (none when the line isn't one, or once it closed),
  // and whether a frame could be written.
  const connect = Effect.fn(function* (port: number) {
    const lines = yield* Queue.unbounded<string | undefined>();
    const socket = yield* Effect.acquireRelease(
      Effect.callback<Socket, AppNotRunning>((resume) => {
        const dialed = createConnection({ host: "127.0.0.1", port });
        // 'close' follows an error, which ends the lines.
        dialed.on("error", () => resume(Effect.fail(notRunning)));
        dialed.once("connect", () => resume(Effect.succeed(dialed)));
        splitLines(dialed, lines);
        return Effect.sync(() => dialed.destroy());
      }),
      (open) => Effect.sync(() => open.destroy()),
    );
    const next: Effect.Effect<Option.Option<Frame>> = Queue.take(lines).pipe(
      Effect.map((line) =>
        line === undefined
          ? Option.none()
          : Schema.decodeOption(FrameSchema)(line),
      ),
    );
    const send = (frame: Readonly<Record<string, unknown>>) =>
      Effect.callback<boolean>((resume) => {
        socket.write(`${JSON.stringify(frame)}\n`, (error) =>
          resume(Effect.succeed(error === undefined || error === null)),
        );
      });
    return { next, send };
  });

  const handshake = Effect.fn(function* (file: {
    readonly port: number;
    readonly token: string;
  }) {
    const connection = yield* connect(file.port);
    if (!(yield* connection.send({ t: "hello", token: file.token }))) {
      return yield* notRunning;
    }
    const welcome = yield* connection.next;
    // The app is there and said so. Any other refusal is a control.json
    // this listener didn't write.
    if (
      Option.isSome(welcome) &&
      welcome.value.t === "refused" &&
      welcome.value.code === "busy"
    ) {
      return yield* new AppBusy({ binary: paths.binaryName });
    }
    if (Option.isNone(welcome) || welcome.value.t !== "welcome") {
      return yield* notRunning;
    }
    return connection;
  });

  const call = Effect.fn("Control.call")(function* (
    channel: string,
    input: unknown,
    onPush?: (pushed: string, payload: unknown) => Effect.Effect<void>,
  ) {
    const found = yield* published;
    // A file left by a crash names a dead pid, or a port nothing (or
    // something else) listens on: both read as not running, the second
    // through the dial or the hello.
    if (Option.isNone(found) || !(yield* pidAlive(found.value.pid))) {
      return yield* notRunning;
    }
    const file = found.value;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // A transfer takes as long as it takes, so nothing past the hello
        // is on a clock.
        const connection = yield* handshake(file).pipe(
          Effect.timeoutOrElse({
            duration: HANDSHAKE_TIMEOUT,
            orElse: () => Effect.fail(notRunning),
          }),
        );
        yield* Effect.logDebug(
          `control: connected to the app (v${file.appVersion}, pid ${file.pid})`,
        );
        const sent = yield* connection.send(
          input === undefined
            ? { t: "req", id: 1, channel }
            : { t: "req", id: 1, channel, input },
        );
        if (!sent) return yield* new ConnectionLost({ channel });
        for (;;) {
          const frame = yield* connection.next;
          if (Option.isNone(frame)) {
            return yield* new ConnectionLost({ channel });
          }
          const { t, id, ok, result, message, code, payload } = frame.value;
          if (t === "push" && onPush !== undefined) {
            yield* onPush(frame.value.channel ?? "", payload);
          }
          // Another call's answer is not ours.
          if (t !== "res" || id !== 1) continue;
          if (ok !== true) {
            return yield* new ControlRefused({
              channel,
              ...(code === undefined || code === "" ? {} : { code }),
              said: message ?? "",
            });
          }
          return result;
        }
      }),
    );
  });

  return Control.of({ call });
});

export const layer = (flavor: Flavor) => Layer.effect(Control, make(flavor));
