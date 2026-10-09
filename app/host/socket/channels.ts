// The host's byte channels on one device link (shared/remote/channels.ts
// has the dialer's). A handler that opens a channel for its caller
// attaches the far end here under the id the caller minted. The
// caller's `read`, `write`, `end` and `reset` calls (modules/link.ts)
// reach it through the link's serving (server.ts). The caller starts
// reading as it attaches its own end, which can be before the open has
// attached this one, so a call naming an id not attached yet waits for
// it, briefly.
import {
  RemoteCallError,
  type CallFailureSchema,
} from "@shigomori/contracts/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type {
  ChannelEndpoint,
  ChannelHandle,
  LinkChannels,
} from "@shigomori/contracts/link";
import { CHANNEL_WINDOW_BYTES } from "@shared/remote/channels";
import { MAX_CHANNELS_PER_LINK } from "@shared/remote/link";
import {
  CHANNEL_OPEN_NO_CHANNELS,
  CHANNEL_OPEN_TAKEN,
  CHANNEL_OPEN_TOO_MANY,
} from "@shigomori/contracts/channelRefusals";

// How long a call naming a channel waits for its open to attach it. An
// open that dials a port or spawns a serve child answers well within.
const ATTACH_WAIT_MS = 60_000;

// Ids the caller reset before anything attached them, kept for the one
// attach that may follow so it comes back closed. Bounded: a caller
// cannot grow it without opening channels too.
const MAX_TOMBSTONES = 64;

type Failure = typeof CallFailureSchema.Type;

const refused = (text: string) => new RemoteCallError({ text });

type Channel = {
  readonly endpoint: ChannelEndpoint;
  readonly outbound: Queue.Queue<Uint8Array, Failure | Cause.Done>;
  readonly invited: boolean;
  queued: number;
  paused: boolean;
  reading: boolean;
  // The next write to hand the endpoint, and the ones that came early.
  nextSeq: number;
  readonly early: Map<number, () => void>;
  sentEnd: boolean;
  receivedEnd: boolean;
  gone: boolean;
};

export type HostChannels = LinkChannels & {
  // The caller's calls on a channel, as the link serves them.
  readonly read: (channelId: string) => Stream.Stream<Uint8Array, Failure>;
  readonly write: (
    channelId: string,
    seq: number,
    data: Uint8Array,
  ) => Effect.Effect<void, Failure>;
  readonly end: (channelId: string) => Effect.Effect<void, Failure>;
  readonly reset: (channelId: string) => Effect.Effect<void>;
  // The command switch turned off: every channel a gated call opened
  // goes, and the ones an invited call opened stay.
  readonly dropUninvited: () => void;
  // The link is gone: every channel resets, and attach refuses.
  readonly closeAll: () => void;
};

export function makeHostChannels(): HostChannels {
  const channels = new Map<string, Channel>();
  const waiting = new Map<string, Deferred.Deferred<Channel, Failure>>();
  const resetBeforeAttach = new Set<string>();
  let dead = false;

  function remove(channelId: string, channel: Channel): void {
    channel.gone = true;
    if (channels.get(channelId) === channel) channels.delete(channelId);
  }

  function maybeComplete(channelId: string, channel: Channel): void {
    if (channel.gone || !channel.sentEnd || !channel.receivedEnd) return;
    remove(channelId, channel);
    channel.endpoint.onComplete?.();
  }

  // Gone from this side: the caller's read fails, which is its reset.
  function drop(channelId: string, channel: Channel): void {
    if (channel.gone) return;
    remove(channelId, channel);
    Queue.failCauseUnsafe(
      channel.outbound,
      Cause.fail(refused(`channel ${channelId} was reset`)),
    );
  }

  const awaitChannel = (channelId: string) =>
    Effect.suspend(() => {
      const channel = channels.get(channelId);
      if (channel !== undefined) return Effect.succeed(channel);
      if (dead || resetBeforeAttach.has(channelId)) {
        return Effect.fail(refused(`channel ${channelId} is gone`));
      }
      let deferred = waiting.get(channelId);
      if (deferred === undefined) {
        deferred = Deferred.makeUnsafe<Channel, Failure>();
        waiting.set(channelId, deferred);
      }
      return Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: ATTACH_WAIT_MS,
          orElse: () =>
            Effect.fail(refused(`channel ${channelId} was never opened`)),
        }),
      );
    });

  return {
    attach(channelId, endpoint, opts) {
      if (dead) throw new Error(CHANNEL_OPEN_NO_CHANNELS);
      if (channels.has(channelId)) throw new Error(CHANNEL_OPEN_TAKEN);
      if (channels.size >= MAX_CHANNELS_PER_LINK) {
        throw new Error(CHANNEL_OPEN_TOO_MANY);
      }
      const channel: Channel = {
        endpoint,
        outbound: Effect.runSync(
          Queue.unbounded<Uint8Array, Failure | Cause.Done>(),
        ),
        invited: opts?.invited === true,
        queued: 0,
        paused: false,
        reading: false,
        nextSeq: 0,
        early: new Map(),
        sentEnd: false,
        receivedEnd: false,
        gone: false,
      };
      const handle: ChannelHandle = {
        channelId,
        get open() {
          return !channel.gone;
        },
        write(data) {
          if (channel.gone || channel.sentEnd) return true;
          if (data.byteLength > 0) {
            channel.queued += data.byteLength;
            Queue.offerUnsafe(channel.outbound, data);
          }
          if (channel.queued > CHANNEL_WINDOW_BYTES) channel.paused = true;
          return !channel.paused;
        },
        end() {
          if (channel.gone || channel.sentEnd) return;
          channel.sentEnd = true;
          Queue.endUnsafe(channel.outbound);
        },
        reset() {
          drop(channelId, channel);
        },
      };
      if (resetBeforeAttach.delete(channelId)) {
        // The caller reset it before this end attached: a closed
        // handle, and the endpoint hears it the way it would have live.
        channel.gone = true;
        queueMicrotask(() => endpoint.onReset());
        return handle;
      }
      channels.set(channelId, channel);
      const waiter = waiting.get(channelId);
      if (waiter !== undefined) {
        waiting.delete(channelId);
        Deferred.doneUnsafe(waiter, Effect.succeed(channel));
      }
      return handle;
    },

    has: (channelId) => channels.has(channelId),
    size: () => channels.size,

    read: (channelId) =>
      Stream.unwrap(
        awaitChannel(channelId).pipe(
          Effect.flatMap((channel) => {
            if (channel.reading) {
              return Effect.fail(
                refused(`channel ${channelId} is read already`),
              );
            }
            channel.reading = true;
            return Effect.succeed(
              // Whatever is queued goes out as one piece of the stream,
              // so the reader's acknowledgement covers all of it.
              Stream.fromQueue(channel.outbound).pipe(
                Stream.mapArray((pieces) => {
                  for (const data of pieces) channel.queued -= data.byteLength;
                  if (channel.paused && channel.queued === 0 && !channel.gone) {
                    channel.paused = false;
                    channel.endpoint.onWritable();
                  }
                  return pieces;
                }),
                Stream.ensuring(
                  Effect.sync(() => maybeComplete(channelId, channel)),
                ),
              ),
            );
          }),
        ),
      ),

    write: (channelId, seq, data) =>
      awaitChannel(channelId).pipe(
        Effect.flatMap((channel) =>
          Effect.callback<void, Failure>((resume) => {
            // Handed over in turn: the endpoint sees the bytes in the
            // order they were written, and answers each once taken.
            const deliver = () => {
              if (channel.gone || channel.receivedEnd) {
                resume(Effect.fail(refused(`channel ${channelId} is closed`)));
                return;
              }
              channel.nextSeq = seq + 1;
              channel.endpoint.onData(data, () => resume(Effect.void));
              const next = channel.early.get(channel.nextSeq);
              if (next !== undefined) {
                channel.early.delete(channel.nextSeq);
                next();
              }
            };
            if (seq === channel.nextSeq) deliver();
            else if (seq > channel.nextSeq) channel.early.set(seq, deliver);
            else resume(Effect.fail(refused(`write ${seq} came twice`)));
          }),
        ),
      ),

    end: (channelId) =>
      awaitChannel(channelId).pipe(
        Effect.flatMap((channel) =>
          Effect.sync(() => {
            if (channel.gone || channel.receivedEnd) return;
            channel.receivedEnd = true;
            channel.endpoint.onEnd();
            maybeComplete(channelId, channel);
          }),
        ),
      ),

    reset: (channelId) =>
      Effect.sync(() => {
        const channel = channels.get(channelId);
        if (channel !== undefined) {
          drop(channelId, channel);
          channel.endpoint.onReset();
          return;
        }
        const waiter = waiting.get(channelId);
        if (waiter !== undefined) {
          waiting.delete(channelId);
          Deferred.doneUnsafe(
            waiter,
            Effect.fail(refused(`channel ${channelId} was reset`)),
          );
        }
        if (resetBeforeAttach.size >= MAX_TOMBSTONES) {
          const oldest = resetBeforeAttach.values().next().value;
          if (oldest !== undefined) resetBeforeAttach.delete(oldest);
        }
        resetBeforeAttach.add(channelId);
      }),

    dropUninvited() {
      for (const [channelId, channel] of channels) {
        if (channel.invited) continue;
        drop(channelId, channel);
        channel.endpoint.onReset();
      }
    },

    closeAll() {
      dead = true;
      for (const waiter of waiting.values()) {
        Deferred.doneUnsafe(waiter, Effect.fail(refused("the link is gone")));
      }
      waiting.clear();
      for (const [channelId, channel] of channels) {
        drop(channelId, channel);
        channel.endpoint.onReset();
      }
    },
  };
}
