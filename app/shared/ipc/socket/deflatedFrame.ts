// Deflated JSON frames: a large text frame (a res carrying a diff or a
// list, a big push) sent as one binary frame holding its raw-deflate
// bytes, because over a tunnel the host's uplink is what such an answer
// waits on and that text deflates to a fraction of its size.
//
// The websocket's own permessage-deflate cannot do this job: Cloudflare
// drops Sec-WebSocket-Extensions on the way to a tunnel's origin (the
// listener never sees the offer), so the extension can never negotiate
// on the one path that needs it. Hence app level, and opt-in per
// connection: a client that can inflate says so in its hello
// (`deflate`), and the host then deflates what is worth it. Additive
// per the version-skew policy: an old client never asks and an old
// host ignores the ask, and either way every frame stays text.
//
// Layout: 1 byte kind, then the raw-deflate stream of the frame's UTF-8
// JSON text. The kind shares the first-byte space with the byte-channel
// frames (channels.ts, kinds 1 to 4) and must stay clear of them.
//
// Host to client only. Client frames are small by construction, except
// an uplink bundle chunk, which is base64 of already-packed bytes.
//
// Pure and browser safe (the web client reads these frames): the
// platform DecompressionStream, no node builtins. The host's deflate
// half is node zlib and lives with the listener (host/socket).
export const DEFLATED_FRAME_KIND = 0x10;

// Text shorter than this goes out as text. Most frames are this small,
// and deflating them would cost a thread hop to save nothing a packet
// boundary notices.
export const DEFLATE_MIN_TEXT_LENGTH = 1024;

// Ceiling on what one frame may inflate to, so a deflated frame cannot
// be a cheaper way to exhaust the reader than a plain one. Generous:
// plain frames have no bound in a browser, and only a host that passed
// the handshake can send one of these at all.
const MAX_INFLATED_FRAME_BYTES = 256 * 1024 * 1024;

// Whether this platform can read deflated frames, which decides if the
// hello asks for them. Asked of the format, not just the class: some
// browsers shipped DecompressionStream years before "deflate-raw".
let inflates: boolean | null = null;
export function canInflateFrames(): boolean {
  if (inflates === null) {
    try {
      const probe = new DecompressionStream("deflate-raw");
      inflates = probe.readable !== undefined;
    } catch {
      inflates = false;
    }
  }
  return inflates;
}

export function isDeflatedFrame(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === DEFLATED_FRAME_KIND;
}

// The frame's JSON text. Rejects on a corrupt stream or one that
// inflates past the ceiling.
export async function inflateFrame(bytes: Uint8Array): Promise<string> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      // slice, not subarray: a copy of the (small, deflated) payload
      // that owns a plain ArrayBuffer, which is what the stream takes.
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_FRAME_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- leaving the loop
      await reader.cancel();
      throw new Error("deflated frame inflates past the ceiling");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
