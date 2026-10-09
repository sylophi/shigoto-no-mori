// The control wire's frames (server.ts): one JSON object per line, a
// hello, then requests answered by id, with pushes beside them. Its own
// until the terminal's control client moves onto the device link's RPC
// (V3.md, step 4), when this file goes.
//
// A field whose value is undefined is left out of a frame, and a reader
// sees it as undefined again, so void inputs and outputs cross as they
// do on the Electron wire.
import { z } from "zod";

// Largest inbound line the listener buffers. Requests are small.
export const MAX_INBOUND_FRAME_BYTES = 1 << 20;

// How long a connection has to say hello.
export const HELLO_TIMEOUT_MS = 10_000;

// Requests one connection may have in flight before the next is
// refused rather than spawning yet another git or CLI process.
export const MAX_IN_FLIGHT_PER_PEER = 64;

// A push is skipped once the socket's outbound buffer passes this, so a
// stalled reader cannot grow the host's memory. Pushes are refresh
// signals, so dropping one is safe.
export const PUSH_BUFFER_LIMIT_BYTES = 1 << 23;

export const ReqFrameSchema = z.object({
  t: z.literal("req"),
  // Client-assigned correlation id, echoed on the matching res.
  id: z.number().int(),
  channel: z.string(),
  // The contract input wire shape. Absent when the input is void.
  input: z.unknown().optional(),
});

// The answer when nothing serves the requested channel.
export function noHandlerMessage(channel: string): string {
  return `No handler registered for channel "${channel}"`;
}

// The failure answer to a req: the message alone, plus the code when
// the refusal has one.
export function resError(id: number, message: string, code?: string) {
  return {
    t: "res",
    id,
    ok: false,
    message,
    ...(code === undefined ? {} : { code }),
  };
}

// A frame that is not valid JSON, or fails its schema, is null: the
// caller drops it rather than tearing down the connection.
export function decodeFrame<T>(text: string, schema: z.ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
