// Byte channels on the device link: a forwarded TCP connection or a
// mirror stream crossing as bytes beside the link's calls. A channel is
// opened by an ordinary call (forward:open, mirror:openStream,
// sync:openSource, sync:receiveBundle) naming an id the dialing side
// minted and attached first, so nothing the host sends can find it
// missing. From then on either side writes, ends its direction, or
// resets the whole channel.
//
// On the wire a channel is the link's own calls (modules/link.ts), each
// direction numbered calls, as many in flight as fill the link and no
// more (makeWindow): the host's bytes come as the answers to `read`
// calls, more asked as this side's endpoint takes them, so a slow
// reader holds the host back. The
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
import type { ChannelEndpoint, ChannelHandle } from "@shigomori/contracts/link";
import {
  CHANNEL_CALLS_IN_FLIGHT,
  CHANNEL_MAX_READ_BYTES,
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

// How much of a channel's bytes one direction keeps in flight: what the
// link carries in a round trip, plus a few milliseconds' worth queued at
// its narrowest point, so a transfer fills the link without the
// terminal, the pushes and the calls beside it waiting behind its
// backlog. Each answered call says how long it took. The quickest seen
// is the link's own round trip and any more is time in a queue, so the
// window moves toward the bytes that round trip carries plus
// QUEUE_TARGET_MS of them (FAST TCP's update, with the queue as a time),
// never less than two calls' worth, which a link waits behind anyway.
// It starts at two calls and grows by one per answer until a queue
// shows. Between one call's bytes and CHANNEL_CALLS_IN_FLIGHT of them.
const QUEUE_TARGET_MS = 20;
const WINDOW_GAIN = 1 / 8;

type Window = {
  readonly bytes: number;
  answered(roundTripMs: number): void;
};

function makeWindow(callBytes: number): Window {
  const most = CHANNEL_CALLS_IN_FLIGHT * callBytes;
  let bytes = 2 * callBytes;
  let quickest = Number.POSITIVE_INFINITY;
  let starting = true;
  return {
    get bytes() {
      return bytes;
    },
    answered(roundTripMs) {
      const took = Math.max(roundTripMs, 0.01);
      quickest = Math.min(quickest, took);
      if (starting && took < quickest + QUEUE_TARGET_MS / 2) {
        bytes = Math.min(most, bytes + callBytes);
        return;
      }
      starting = false;
      const queue = Math.max(2 * callBytes, (bytes * QUEUE_TARGET_MS) / took);
      const target = (bytes * quickest) / took + queue;
      bytes += WINDOW_GAIN * (target - bytes);
      bytes = Math.min(most, Math.max(callBytes, bytes));
    },
  };
}

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

      // The far end's bytes, read ahead by as many calls as the window
      // holds and handed to the endpoint in turn, more asked once it took
      // one. An empty answer is the far end's end. Reads still in flight
      // then are interrupted with the reader.
      const reading = makeWindow(CHANNEL_MAX_READ_BYTES);
      const reader = Effect.gen(function* () {
        const asked: Fiber.Fiber<Uint8Array, unknown>[] = [];
        let seq = 0;
        const ask = Effect.suspend(() => {
          const started = performance.now();
          return Effect.map(
            Effect.forkChild(
              calls
                .read(channelId, seq++)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() =>
                      reading.answered(performance.now() - started),
                    ),
                  ),
                ),
            ),
            (fiber) => {
              asked.push(fiber);
            },
          );
        });
        const askWhileRoom = Effect.whileLoop({
          while: () =>
            asked.length < CHANNEL_CALLS_IN_FLIGHT &&
            (asked.length === 0 ||
              (asked.length + 1) * CHANNEL_MAX_READ_BYTES <= reading.bytes),
          body: () => ask,
          step: () => {},
        });
        for (;;) {
          yield* askWhileRoom;
          const data = yield* Fiber.join(
            asked.shift() as Fiber.Fiber<Uint8Array, unknown>,
          );
          if (data.byteLength === 0) return;
          yield* Effect.callback<void>((resume) => {
            if (channel.gone) return resume(Effect.void);
            endpoint.onData(data, () => resume(Effect.void));
          });
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

      // This side's bytes, numbered, as many writes in flight as the
      // window holds. The end goes once every write was answered.
      const writing = makeWindow(CHANNEL_MAX_WRITE_BYTES);
      let seq = 0;
      let sending = 0;
      let sendingBytes = 0;
      let answers = 0;
      let answered: (() => void) | null = null;
      const roomFor = (bytes: number) =>
        sending === 0 ||
        (sending < CHANNEL_CALLS_IN_FLIGHT &&
          sendingBytes + bytes <= writing.bytes);
      // Once a write in flight was answered, since `seen` were.
      const anAnswer = (seen: number) =>
        Effect.callback<void>((resume) => {
          if (answers !== seen) return resume(Effect.void);
          answered = () => resume(Effect.void);
          return Effect.sync(() => {
            answered = null;
          });
        });
      const send = (data: Uint8Array) => {
        const started = performance.now();
        sending += 1;
        sendingBytes += data.byteLength;
        return calls.call("link:write", { channelId, seq: seq++, data }).pipe(
          Effect.matchCause({
            onSuccess: () => {
              writing.answered(performance.now() - started);
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
          Effect.ensuring(
            Effect.sync(() => {
              sending -= 1;
              sendingBytes -= data.byteLength;
              answers += 1;
              const wake = answered;
              answered = null;
              wake?.();
            }),
          ),
        );
      };
      const writer = Effect.gen(function* () {
        while (true) {
          const piece = yield* Queue.take(queue);
          if (piece === "end") {
            // oxlint-disable-next-line no-unmodified-loop-condition -- each answer lowers it
            while (sending > 0) yield* anAnswer(answers);
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
            const data = piece.subarray(
              offset,
              offset + CHANNEL_MAX_WRITE_BYTES,
            );
            while (!roomFor(data.byteLength)) yield* anAnswer(answers);
            // In the link's fibers: a reset leaves it to fail on its own.
            calls.fork(send(data));
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
