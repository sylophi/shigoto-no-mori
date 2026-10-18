// What one message of a served stream (a view, a push) may carry. The RPC
// server sends each piece its stream hands over as one message, and a
// stream backed by a queue hands over everything waiting: a terminal's
// output a slow window has not taken, a peer's view relayed through
// hub:watchPeer. Unbounded, that is one frame past what the far end's
// decoder takes (LINK_MAX_FRAME_BYTES, 32 MiB), which fails it, and
// holds the link for as long as the frame takes besides.
// So a piece is cut into messages of at most MAX_MESSAGE_BYTES, by an
// upper bound on their encoded size; a single value past it goes alone.
import * as Stream from "effect/Stream";

// The largest frame the link's listener admits (DeviceLink.ts), a call
// well past any a peer makes (a channel write is at most 32 KiB of
// bytes), and so the largest message of a stream the other way.
export const MAX_MESSAGE_BYTES = 1 << 20;

// At least the bytes `value` takes in the binary layout: a string's
// UTF-16 code units at three UTF-8 bytes each, bytes as they are, and
// every key, number and marker counted generously.
function encodedSizeBound(value: unknown): number {
  if (typeof value === "string") return 3 * value.length + 9;
  if (value instanceof Uint8Array) return value.byteLength + 9;
  if (Array.isArray(value)) {
    let size = 9;
    for (const item of value) size += encodedSizeBound(item);
    return size;
  }
  if (typeof value === "object" && value !== null) {
    let size = 9;
    for (const [key, item] of Object.entries(value)) {
      size += 3 * key.length + encodedSizeBound(item);
    }
    return size;
  }
  return 9;
}

export const boundedMessages = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  stream.pipe(
    Stream.chunks,
    Stream.flatMap((values) => {
      const messages: A[][] = [];
      let message: A[] = [];
      let size = 0;
      for (const value of values) {
        const bound = encodedSizeBound(value);
        if (message.length > 0 && size + bound > MAX_MESSAGE_BYTES) {
          messages.push(message);
          message = [];
          size = 0;
        }
        message.push(value);
        size += bound;
      }
      messages.push(message);
      return Stream.fromArrays(...messages);
    }),
  );
