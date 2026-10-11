// Byte channels on the device link: a forwarded TCP connection or a
// mirror stream crossing as bytes beside the link's calls. A channel is
// opened by an ordinary call (forward:open, mirror:openStream,
// sync:openSource, sync:receiveBundle) naming an id the dialing side
// minted and attached first, so nothing the host sends can find it
// missing. From then on either side writes, ends its direction, or
// resets the whole channel.
//
// On the wire a channel is the link's own calls (modules/link.ts), each
// direction numbered calls with a few in flight: the host's bytes come
// as the answers to `read` calls, the next asked only once this side's
// endpoint took a piece, so a slow reader holds the host back. The
// dialer's bytes are `write` calls, each answered once the host's sink
// took them, so a slow sink holds the dialer back. A read is never
// answered with more than this side asked for, so what waits on the
// socket for a busy reader is bounded and never stalls the link's other
// calls, as a stream's pieces would (the RPC client queues those in its
// socket's read loop). The host's half is host/socket/channels.ts.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import type { ChannelEndpoint, ChannelHandle } from "@shigomori/contracts/link";
import {
  CHANNEL_CALLS_IN_FLIGHT,
  CHANNEL_MAX_WRITE_BYTES,
} from "@shigomori/contracts/modules/link";

// The dialing side's channels on one link.
export type ChannelMux = {
  // Throws when the id is attached already or the link is gone.
  attach(channelId: string, endpoint: ChannelEndpoint): ChannelHandle;
  has(channelId: string): boolean;
  size(): number;
};

// Bytes a side queues before its writer is told to pause.
export const CHANNEL_WINDOW_BYTES = 4 * 1024 * 1024;

// The link calls a dialer's channels ride.
export type ChannelCalls = {
  readonly call: (
    tag: "link:write" | "link:end" | "link:reset",
    payload: unknown,
  ) => Effect.Effect<void, unknown>;
  readonly read: (
    channelId: string,
    seq: number,
  ) => Effect.Effect<Uint8Array, unknown>;
  // Runs a fiber for as long as the link lives.
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
};

type Piece = Uint8Array | "end";

export function createChannelMux(calls: ChannelCalls): ChannelMux & {
  // The link is gone: every channel resets, and attach refuses.
  readonly closeAll: () => void;
} {
  type Channel = {
    readonly endpoint: ChannelEndpoint;
    readonly fibers: Fiber.Fiber<unknown, unknown>[];
    gone: boolean;
    sentEnd: boolean;
    receivedEnd: boolean;
  };
  const channels = new Map<string, Channel>();
  let dead = false;

  function finish(channelId: string, channel: Channel): void {
    channel.gone = true;
    if (channels.get(channelId) === channel) channels.delete(channelId);
    for (const fiber of channel.fibers) calls.fork(Fiber.interrupt(fiber));
  }

  function maybeComplete(channelId: string, channel: Channel): void {
    if (channel.gone || !channel.sentEnd || !channel.receivedEnd) return;
    finish(channelId, channel);
    channel.endpoint.onComplete?.();
  }

  // The far end reset it, or the link died: the endpoint hears it.
  function lost(channelId: string, channel: Channel): void {
    if (channel.gone) return;
    finish(channelId, channel);
    channel.endpoint.onReset();
  }

  return {
    attach(channelId, endpoint) {
      if (dead) throw new Error("the device link is gone");
      if (channels.has(channelId)) {
        throw new Error(`channel ${channelId} is already attached`);
      }
      const channel: Channel = {
        endpoint,
        fibers: [],
        gone: false,
        sentEnd: false,
        receivedEnd: false,
      };
      channels.set(channelId, channel);
      const queue = Effect.runSync(Queue.unbounded<Piece>());
      let queued = 0;
      let paused = false;

      // The far end's bytes, read ahead by a few calls and handed to the
      // endpoint in turn, the next asked once it took one. An empty
      // answer is the far end's end. Reads still in flight then are
      // interrupted with the reader.
      const reader = Effect.gen(function* () {
        const asked: Fiber.Fiber<Uint8Array, unknown>[] = [];
        let seq = 0;
        const ask = Effect.suspend(() =>
          Effect.map(
            Effect.forkChild(calls.read(channelId, seq++)),
            (fiber) => {
              asked.push(fiber);
            },
          ),
        );
        for (let n = 0; n < CHANNEL_CALLS_IN_FLIGHT; n++) yield* ask;
        for (;;) {
          const data = yield* Fiber.join(
            asked.shift() as Fiber.Fiber<Uint8Array, unknown>,
          );
          if (data.byteLength === 0) return;
          yield* Effect.callback<void>((resume) => {
            if (channel.gone) return resume(Effect.void);
            endpoint.onData(data, () => resume(Effect.void));
          });
          yield* ask;
        }
      }).pipe(
        Effect.matchCause({
          onSuccess: () => {
            if (channel.gone) return;
            channel.receivedEnd = true;
            endpoint.onEnd();
            maybeComplete(channelId, channel);
          },
          onFailure: (cause) => {
            if (!Cause.hasInterruptsOnly(cause)) lost(channelId, channel);
          },
        }),
      );

      // This side's bytes, numbered, with a few writes in flight at once
      // so a long link is not one round trip per piece. The end goes
      // once every write was answered.
      const inFlight = Semaphore.makeUnsafe(CHANNEL_CALLS_IN_FLIGHT);
      let seq = 0;
      const send = (data: Uint8Array) =>
        calls.call("link:write", { channelId, seq: seq++, data }).pipe(
          Effect.matchCause({
            onSuccess: () => {
              queued -= data.byteLength;
              if (paused && queued === 0 && !channel.gone) {
                paused = false;
                endpoint.onWritable();
              }
            },
            onFailure: (cause) => {
              if (!Cause.hasInterruptsOnly(cause)) lost(channelId, channel);
            },
          }),
          Effect.ensuring(inFlight.release(1)),
        );
      const writer = Effect.gen(function* () {
        while (true) {
          const piece = yield* Queue.take(queue);
          if (piece === "end") {
            yield* inFlight.take(CHANNEL_CALLS_IN_FLIGHT);
            if (channel.gone) return;
            yield* calls.call("link:end", { channelId });
            channel.sentEnd = true;
            maybeComplete(channelId, channel);
            return;
          }
          for (
            let offset = 0;
            offset < piece.byteLength;
            offset += CHANNEL_MAX_WRITE_BYTES
          ) {
            yield* inFlight.take(1);
            // In the link's fibers: a reset leaves it to fail on its own.
            calls.fork(
              send(piece.subarray(offset, offset + CHANNEL_MAX_WRITE_BYTES)),
            );
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!Cause.hasInterruptsOnly(cause)) lost(channelId, channel);
          }),
        ),
      );

      channel.fibers.push(calls.fork(reader), calls.fork(writer));
      let ending = false;
      return {
        channelId,
        get open() {
          return !channel.gone;
        },
        write(data) {
          if (channel.gone || ending) return true;
          if (data.byteLength > 0) {
            queued += data.byteLength;
            Queue.offerUnsafe(queue, data);
          }
          if (queued > CHANNEL_WINDOW_BYTES) paused = true;
          return !paused;
        },
        end() {
          if (channel.gone || ending) return;
          ending = true;
          Queue.offerUnsafe(queue, "end");
        },
        reset() {
          if (channel.gone) return;
          finish(channelId, channel);
          calls.fork(Effect.ignore(calls.call("link:reset", { channelId })));
        },
      };
    },
    has: (channelId) => channels.has(channelId),
    size: () => channels.size,
    closeAll() {
      dead = true;
      for (const [channelId, channel] of channels) lost(channelId, channel);
    },
  };
}
