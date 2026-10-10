// The device link a second time, on loopback, for the processes on this
// machine: the terminal `sm` (packages/engine/src/Control.ts) and, once
// the host runs as a process of its own, the app's windows. It serves
// LoopbackGroup (@shigomori/contracts/link): every host call, its pushes
// and views, and the control contract's ops.
//
// Other accounts on this machine can reach loopback, so its hello
// carries a token minted as the host starts. The host publishes the
// port and the token in <dataDir>/loopback.json, owner-only, which is
// what names an app instance (flavor and dev profile) to the terminal,
// and hands them to whoever asks (address).
//
// A token in the clear is enough here, where a peer's link needs a
// sealed socket: loopback traffic never leaves the machine, so only
// this machine's own processes see it, and a dialer learns the port
// from the same owner-only file as the token, so nothing else can stand
// in for the listener it dials.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LoopbackGroup } from "@shigomori/contracts/link";
import { mintHexId } from "@host/lib/hexId";
import { type LinkRegistrar, make as makeLink } from "./server";

// The engine's Control.ts reads this name and shape.
export const LOOPBACK_FILE = "loopback.json";

class LoopbackBindError extends Schema.TaggedError<LoopbackBindError>()(
  "LoopbackBindError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The loopback listener could not start: ${this.reason}`;
  }
}

export class Loopback extends Context.Service<
  Loopback,
  {
    // Where the loopback listens, and the token its handshake proves.
    readonly address: Effect.Effect<{
      readonly port: number;
      readonly token: string;
    }>;
    // Takes loopback.json away, before the data-folder move carries the
    // data dir off: a terminal then reads the app as not running rather
    // than dialing one about to relaunch.
    readonly unpublish: Effect.Effect<void>;
    // Writes it again, after a data wipe took it along.
    readonly publish: Effect.Effect<void>;
  }
>()("sm/host/Loopback") {}

const make = (options: {
  readonly registrar: LinkRegistrar;
  readonly deviceId: () => string;
  readonly appVersion: string;
  // Where loopback.json goes: the data dir's, resolved late because the
  // data dir is a boot-time fact.
  readonly file: () => string;
  // The one page origin the listener admits beside an origin-less dial:
  // the desktop window's (its renderer scheme), which dials it too.
  readonly allowedOrigin?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const token = mintHexId();
    const link = yield* makeLink({
      registrar: options.registrar,
      group: LoopbackGroup,
      local: true,
      auth: {
        opens: { token },
        // Its callers command this machine as its owner.
        isCommandGranted: () => true,
      },
    });
    yield* link.reconcile(
      Effect.sync(() => ({
        port: 0,
        bindAddress: "127.0.0.1",
        deviceId: options.deviceId(),
        appVersion: options.appVersion,
        ...(options.allowedOrigin === undefined
          ? {}
          : { allowedOrigin: options.allowedOrigin }),
      })),
    );
    const status = yield* link.status;
    if (!status.listening || status.port === null) {
      return yield* new LoopbackBindError({ reason: status.error ?? "" });
    }
    const port = status.port;
    const content = JSON.stringify({
      pid: process.pid,
      port,
      token,
      appVersion: options.appVersion,
    });
    // Written aside and renamed in, so a terminal never reads half of it.
    const publish = Effect.gen(function* () {
      const file = options.file();
      const partial = `${file}.${process.pid}`;
      yield* fs.writeFileString(partial, content, { mode: 0o600 });
      yield* fs.rename(partial, file);
    }).pipe(Effect.ignore, Effect.withSpan("Loopback.publish"));
    // Only the file this listener wrote: another instance may have
    // published its own since.
    const unpublish = Effect.gen(function* () {
      const file = options.file();
      const held = yield* fs.readFileString(file);
      if (held === content) yield* fs.remove(file);
    }).pipe(Effect.ignore, Effect.withSpan("Loopback.unpublish"));
    yield* publish;
    yield* Effect.addFinalizer(() => unpublish);
    return Loopback.of({
      address: Effect.succeed({ port, token }),
      unpublish,
      publish,
    });
  });

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(Loopback, make(options));
