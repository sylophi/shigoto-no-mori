// The loopback gateway this device's `file-sync daemon` reaches peers
// through (file-sync/engine.go, "Gateway protocol handler"). One listener for
// the app's life. Every accepted socket is one mirror stream. The
// daemon writes a JSON preface line naming the peer device and the
// worktree there, the gateway opens the peer's `file-sync serve` on a
// byte channel of the direct session (mirror:openStream), answers
// "ok" (or "error <why>"), and from then on the socket is bridged onto
// that channel exactly like a port forward (host/portForward/
// bridge.ts). Nothing here knows Mutagen's protocol: the preface is
// the only line the gateway reads.
//
// Loopback keeps the listener off the network but not away from other
// accounts on this machine, which could find the port and drive mirror
// streams against peer devices. So the preface carries a token minted
// at bind and handed to the daemon through its environment, never
// argv, which every account can read from `ps`.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { createServer, type Socket } from "node:net";
import { errorWordsOf } from "@host/lib/errorWords";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import * as PeerReach from "@host/ipc/PeerReach";
import { WorktreeIdSchema } from "@shigomori/contracts/schemas";
import { mintHexId } from "@host/lib/hexId";
import { secretsMatch } from "@host/lib/util/secretCompare";
import { MAX_CONNS_PER_DEVICE } from "@host/portForward/engine";
import { MAX_CHANNELS_PER_LINK } from "@shared/remote/link";
import {
  type BridgedConn,
  bridgeSocket,
  listenLoopback,
} from "@host/portForward/bridge";
import { log } from "@shared/log";
import { transferInto } from "./registry";

// file-sync/engine.go reads this exact name.
export const MIRROR_GATEWAY_TOKEN_ENV = "SM_MIRROR_GATEWAY_TOKEN";

// The preface (file-sync/engine.go mirrorPreface), reduced to the
// fields the gateway acts on. A token that is not a string is checked
// as an empty one, so it is refused as a bad token.
const PrefaceSchema = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.optional(
      Schema.String.pipe(
        Schema.catchDecoding(() => Effect.succeed(Option.some(""))),
      ),
    ),
    deviceId: Schema.NonEmptyString,
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
    // This device's own worktree for the session, when the daemon named
    // it (see engine.go mirrorParamLocalWorktreeID). Passed on so the
    // peer's serving list can name the local copy. One that is not a
    // worktree id is left out, not refused.
    localWorktreeId: Schema.optional(
      WorktreeIdSchema.pipe(
        Schema.catchDecoding(() => Effect.succeed(Option.none())),
      ),
    ),
  }),
);
const decodePreface = Schema.decodeUnknownResult(PrefaceSchema);

// A move's files step, told to the peer so it counts the stream as
// under way (registry.ts transferInto). A live mirror's is not.
const transferOf = (preface: { deviceId: string; worktreeId: string }) => {
  const transfer = transferInto(preface.deviceId, preface.worktreeId);
  return transfer === undefined ? {} : { transfer };
};

// A preface is a short JSON line. Anything longer is not our daemon.
const PREFACE_LIMIT_BYTES = 8 * 1024;
// The daemon's own connect timeout is 30s (file-sync/engine.go), so a
// preface that has not arrived well before that is a dead dial.
const PREFACE_TIMEOUT_MS = 10_000;
// Sanity bound, not a quota: one stream per mirror session, and a
// runaway loop should not exhaust the per-connection channel budget
// it shares with the port forwards to the same device, so it takes
// what the forwards leave.
const MAX_STREAMS = MAX_CHANNELS_PER_LINK - MAX_CONNS_PER_DEVICE;
// A bind that fails (a loopback oddity) is tried again this often
// rather than given up on: the daemon waits on its own restart ladder
// and picks the address up once bound.
const BIND_RETRY = "30 seconds";

// Reads bytes until the first newline. Whatever follows it belongs to
// the stream and is handed back untouched.
function readPreface(
  socket: Socket,
): Promise<{ line: string; carried: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("preface timed out"));
    }, PREFACE_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before the preface"));
    };
    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > PREFACE_LIMIT_BYTES) {
          cleanup();
          reject(new Error("preface too long"));
        }
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      cleanup();
      socket.pause();
      resolve({
        line: Buffer.concat(chunks).toString("utf8").trim(),
        carried: chunk.subarray(newline + 1),
      });
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

// Where the daemon dials and the token it presents, for one bind.
export type MirrorGatewayAddress = {
  readonly address: string;
  readonly token: string;
};

export class MirrorGateway extends Context.Service<
  MirrorGateway,
  {
    // The listener's address and token, none until a bind has
    // succeeded. The daemon reads it at each spawn.
    readonly listening: Effect.Effect<Option.Option<MirrorGatewayAddress>>;
    readonly streamCount: Effect.Effect<number>;
  }
>()("sm/host/MirrorGateway") {}

const make = Effect.gen(function* () {
  const reach = yield* PeerReach.PeerReach;
  const listening = yield* Ref.make(Option.none<MirrorGatewayAddress>());
  const streams = new Set<BridgedConn>();
  const run = yield* FiberSet.makeRuntimePromise<never>();

  const handleConnection = (token: string) => (socket: Socket) => {
    // 'close' always follows 'error'. The listener must exist or the
    // error is an uncaught throw.
    socket.on("error", () => {});
    if (streams.size >= MAX_STREAMS) {
      socket.end("error too many mirror streams\n");
      return;
    }
    readPreface(socket).then(
      ({ line, carried }) => {
        const decoded = decodePreface(line);
        if (Result.isFailure(decoded)) {
          socket.end("error bad preface\n");
          return;
        }
        const preface = decoded.success;
        if (!secretsMatch(preface.token ?? "", token)) {
          // Nothing legitimate reaches here, so log it.
          log.warn("[mirror] gateway refused a connection with a bad token");
          socket.end("error bad preface\n");
          return;
        }
        const api = reach.calls(mirrorContract, preface.deviceId);
        const conn = bridgeSocket(socket, {
          channels: reach.channels(preface.deviceId),
          open: (channelId) =>
            run(
              api.openStream({
                projectId: preface.projectId,
                worktreeId: preface.worktreeId,
                channelId,
                ...(preface.localWorktreeId === undefined
                  ? {}
                  : { peerWorktreeId: preface.localWorktreeId }),
                ...transferOf(preface),
              }),
            ),
          carried,
          // The bridge resumes the socket itself once the far end is
          // open. The answer line goes out just before.
          onOpened: () => {
            socket.write("ok\n");
          },
          onOpenFailed: (error) => {
            log.warn(
              `[mirror] gateway: opening ${preface.deviceId}/${preface.worktreeId} failed: ${errorWordsOf(error)}`,
            );
            socket.write(`error ${errorWordsOf(error).replace(/\n/g, " ")}\n`);
          },
          onClosed: () => {
            streams.delete(conn);
          },
        });
        streams.add(conn);
      },
      (error: unknown) => {
        log.warn(`[mirror] gateway: ${errorWordsOf(error)}`);
        socket.destroy();
      },
    );
  };

  // The loopback listener on an ephemeral port, held until the layer
  // closes. Acquired whole, so a close while it binds waits for the
  // bind and then releases it.
  const bind = Effect.acquireRelease(
    Effect.tryPromise(async () => {
      // Minted per bind, so a token cannot outlive the listener it opened.
      const token = mintHexId();
      const listener = createServer(
        { allowHalfOpen: true },
        handleConnection(token),
      );
      listener.on("error", () => {});
      const port = await listenLoopback(listener, 0);
      return { listener, address: `127.0.0.1:${port}`, token };
    }),
    ({ listener }) =>
      Effect.gen(function* () {
        yield* Ref.set(listening, Option.none());
        listener.close();
        for (const conn of streams) conn.destroy();
      }),
  ).pipe(
    Effect.flatMap(({ address, token }) =>
      Ref.set(listening, Option.some({ address, token })),
    ),
    Effect.tapError((error) =>
      Effect.logWarning(
        `[mirror] gateway failed to bind, retrying: ${errorWordsOf(error.cause)}`,
      ),
    ),
  );

  // The first bind is part of the layer's start, so the daemon above
  // it spawns with an address; a failed one is retried in the layer's
  // scope, which ends the retry and any bind it has under way.
  if (Exit.isFailure(yield* Effect.exit(bind))) {
    yield* bind.pipe(
      Effect.retry(Schedule.spaced(BIND_RETRY)),
      Effect.delay(BIND_RETRY),
      Effect.forkScoped,
    );
  }

  return MirrorGateway.of({
    listening: Ref.get(listening),
    streamCount: Effect.sync(() => streams.size),
  });
});

export const layer = Layer.effect(MirrorGateway, make);
