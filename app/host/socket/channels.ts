// The host's byte channels on one device link (shared/remote/channels.ts
// has the dialer's). A handler that opens a channel for its caller
// attaches the far end here under the id the caller minted. The
// caller's `read`, `write`, `end` and `reset` calls (modules/link.ts)
// reach it through the link's serving (server.ts). The caller starts
// reading as it attaches its own end, which can be before the open has
// attached this one, so a call naming an id not attached yet waits for
// it, briefly. A call naming one this side dropped fails at once: the
// caller hears a drop only through its calls.
//
// Both directions are numbered calls the caller keeps in flight, as
// many as fill the link (shared/remote/channels.ts sizes them): a read
// answers the next of this side's queued bytes, a write hands the
// caller's to the endpoint, each in its number's turn. A call further
// ahead than CHANNEL_CALLS_IN_FLIGHT is refused, so a channel holds a
// bounded number of them, and at most that many writes' bytes.
import {
  ChannelRefusedError,
  RemoteCallError,
  type CallFailureSchema,
} from "@shigomori/contracts/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type {
  ChannelEndpoint,
  ChannelHandle,
  LinkChannels,
} from "@shigomori/contracts/link";
import {
  CHANNEL_CALLS_IN_FLIGHT,
  CHANNEL_MAX_READ_BYTES,
} from "@shigomori/contracts/modules/link";
import { CHANNEL_WINDOW_BYTES } from "@shared/remote/channels";
import { MAX_CHANNELS_PER_LINK } from "@shared/remote/link";

// How long a call naming a channel waits for its open to attach it. An
// open that dials a port or spawns a serve child answers well within.
const ATTACH_WAIT_MS = 60_000;

// Ids gone with no channel left to say so: the ones this side dropped,
// and the ones the caller reset before anything attached them, kept for
// the one attach that may follow so it comes back closed. Bounded, the
// oldest going first.
const MAX_TOMBSTONES = 64;

type Failure = typeof CallFailureSchema.Type;

const refused = (text: string) => new RemoteCallError({ text });

// Why a call numbered `seq` cannot wait its turn behind `next`: it
// came already, or it is further ahead than a caller may be.
function outOfTurn(kind: string, seq: number, next: number): string | null {
  if (seq < next) return `${kind} ${seq} came twice`;
  if (seq >= next + CHANNEL_CALLS_IN_FLIGHT) {
    return `${kind} ${seq} is further ahead than ${CHANNEL_CALLS_IN_FLIGHT}`;
  }
  return null;
}

type Channel = {
  readonly endpoint: ChannelEndpoint;
  // This side's bytes the caller has not read yet.
  readonly outbound: Uint8Array[];
  queued: number;
  paused: boolean;
  // The next read to answer, and the reads waiting, by number.
  nextRead: number;
  readonly reads: Map<
    number,
    (answer: Effect.Effect<Uint8Array, Failure>) => void
  >;
  // The next write to hand the endpoint, and the ones that came early.
  nextSeq: number;
  readonly early: Map<number, () => void>;
  sentEnd: boolean;
  // The caller read the end: this direction is done.
  readEnd: boolean;
  receivedEnd: boolean;
  gone: boolean;
};

// The queued bytes a read answers with, up to a read's most: whole
// pieces where they fit, the rest of one split off for the next.
function takeBatch(channel: Channel): Uint8Array {
  const first = channel.outbound[0];
  if (first === undefined) return new Uint8Array(0);
  if (first.byteLength >= CHANNEL_MAX_READ_BYTES) {
    if (first.byteLength === CHANNEL_MAX_READ_BYTES) channel.outbound.shift();
    else channel.outbound[0] = first.subarray(CHANNEL_MAX_READ_BYTES);
    return first.subarray(0, CHANNEL_MAX_READ_BYTES);
  }
  let size = 0;
  let count = 0;
  for (const piece of channel.outbound) {
    if (size + piece.byteLength > CHANNEL_MAX_READ_BYTES) break;
    size += piece.byteLength;
    count += 1;
  }
  if (count === 1) return channel.outbound.shift() as Uint8Array;
  const batch = new Uint8Array(size);
  let offset = 0;
  for (const piece of channel.outbound.splice(0, count)) {
    batch.set(piece, offset);
    offset += piece.byteLength;
  }
  return batch;
}

export type HostChannels = LinkChannels & {
  // The caller's calls on a channel, as the link serves them.
  readonly read: (
    channelId: string,
    seq: number,
  ) => Effect.Effect<Uint8Array, Failure>;
  readonly write: (
    channelId: string,
    seq: number,
    data: Uint8Array,
  ) => Effect.Effect<void, Failure>;
  readonly end: (channelId: string) => Effect.Effect<void, Failure>;
  readonly reset: (channelId: string) => Effect.Effect<void>;
  // A switch turned off: every channel goes, and the link takes new ones
  // once both are on again.
  readonly dropAll: () => void;
  // The link is gone: every channel resets, and attach refuses.
  readonly closeAll: () => void;
};

export function makeHostChannels(): HostChannels {
  const channels = new Map<string, Channel>();
  const waiting = new Map<string, Deferred.Deferred<Channel, Failure>>();
  const tombstones = new Set<string>();
  let dead = false;

  function tombstone(channelId: string): void {
    if (tombstones.size >= MAX_TOMBSTONES) {
      const oldest = tombstones.values().next().value;
      if (oldest !== undefined) tombstones.delete(oldest);
    }
    tombstones.add(channelId);
  }

  function remove(channelId: string, channel: Channel): void {
    channel.gone = true;
    if (channels.get(channelId) === channel) channels.delete(channelId);
  }

  function maybeComplete(channelId: string, channel: Channel): void {
    if (channel.gone || !channel.readEnd || !channel.receivedEnd) return;
    remove(channelId, channel);
    channel.endpoint.onComplete?.();
  }

  // Gone from this side: the caller's reads fail, which is its reset,
  // the ones waiting here and the ones still on their way.
  function drop(channelId: string, channel: Channel): void {
    if (channel.gone) return;
    remove(channelId, channel);
    tombstone(channelId);
    channel.outbound.length = 0;
    const failed = Effect.fail(refused(`channel ${channelId} was reset`));
    for (const answer of channel.reads.values()) answer(failed);
    channel.reads.clear();
  }

  // Answers the reads waiting in turn while there are bytes, or the end,
  // to answer them with: the first read past the end answers empty, and
  // so does every read the caller had in flight behind it. The bytes
  // answered leave the window, and a paused writer resumes once all of
  // it was read.
  function serveReads(channelId: string, channel: Channel): void {
    for (;;) {
      const answer = channel.reads.get(channel.nextRead);
      if (answer === undefined) return;
      if (channel.outbound.length === 0 && !channel.sentEnd) return;
      channel.reads.delete(channel.nextRead);
      channel.nextRead += 1;
      const bytes = takeBatch(channel);
      if (bytes.byteLength === 0) {
        answer(Effect.succeed(bytes));
        if (!channel.readEnd) {
          channel.readEnd = true;
          maybeComplete(channelId, channel);
        }
        continue;
      }
      channel.queued -= bytes.byteLength;
      answer(Effect.succeed(bytes));
      if (channel.paused && channel.queued === 0 && !channel.gone) {
        channel.paused = false;
        channel.endpoint.onWritable();
      }
    }
  }

  const awaitChannel = (channelId: string) =>
    Effect.suspend(() => {
      const channel = channels.get(channelId);
      if (channel !== undefined) return Effect.succeed(channel);
      if (dead || tombstones.has(channelId)) {
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
    attach(channelId, endpoint) {
      if (dead) throw new ChannelRefusedError({ reason: "no-byte-channels" });
      if (channels.has(channelId))
        throw new ChannelRefusedError({ reason: "channel-taken" });
      if (channels.size >= MAX_CHANNELS_PER_LINK) {
        throw new ChannelRefusedError({ reason: "too-many-conns" });
      }
      const channel: Channel = {
        endpoint,
        outbound: [],
        queued: 0,
        paused: false,
        nextRead: 0,
        reads: new Map(),
        nextSeq: 0,
        early: new Map(),
        sentEnd: false,
        readEnd: false,
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
            channel.outbound.push(data);
            serveReads(channelId, channel);
          }
          if (channel.queued > CHANNEL_WINDOW_BYTES) channel.paused = true;
          return !channel.paused;
        },
        end() {
          if (channel.gone || channel.sentEnd) return;
          channel.sentEnd = true;
          serveReads(channelId, channel);
        },
        reset() {
          drop(channelId, channel);
        },
      };
      if (tombstones.delete(channelId)) {
        // An id gone already (most often the caller's reset, come before
        // this end attached): a closed handle, and the endpoint hears it
        // the way it would have live.
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

    read: (channelId, seq) =>
      awaitChannel(channelId).pipe(
        Effect.flatMap((channel) =>
          Effect.callback<Uint8Array, Failure>((resume) => {
            if (channel.gone) {
              resume(Effect.fail(refused(`channel ${channelId} was reset`)));
              return;
            }
            const refusal = outOfTurn("read", seq, channel.nextRead);
            if (refusal !== null || channel.reads.has(seq)) {
              resume(Effect.fail(refused(refusal ?? `read ${seq} came twice`)));
              return;
            }
            channel.reads.set(seq, resume);
            serveReads(channelId, channel);
            // A read the caller gave up on (its reset, the link going)
            // leaves its turn to nobody: the channel goes with it.
            return Effect.sync(() => {
              if (channel.reads.get(seq) === resume) channel.reads.delete(seq);
            });
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
            const refusal = outOfTurn("write", seq, channel.nextSeq);
            if (refusal !== null || channel.early.has(seq)) {
              resume(
                Effect.fail(refused(refusal ?? `write ${seq} came twice`)),
              );
            } else if (seq === channel.nextSeq) deliver();
            else channel.early.set(seq, deliver);
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
        tombstone(channelId);
      }),

    dropAll() {
      for (const [channelId, channel] of channels) {
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
