// Byte channels on the direct websocket: raw binary frames multiplexed
// beside the JSON invoke/push frames, so a byte stream (a forwarded
// TCP connection, the file-sync engine's protocol) crosses as bytes
// with no base64, no JSON, and no round trip per chunk. Both ends run
// this same multiplexer: the host binding (host/socket/server.ts)
// over its authed socket, the client transport
// (shared/ipc/socket/wsClientTransport.ts) over its socket.
//
// A channel is opened by an ordinary invoke (forward:open or
// forward:openMirror, shared/ipc/modules/forward.ts) that names a
// CLIENT-minted channel id, and the client attaches its endpoint
// BEFORE sending that invoke, so the host's first bytes can never
// arrive at an unattached channel. From then on the channel is
// symmetric: either side writes data, ends its direction, or resets
// the whole channel.
//
// Flow control is credit-based, per channel, per direction, and it
// is what keeps a fast producer from growing the far end's memory:
// each direction starts with CHANNEL_WINDOW_BYTES of credit, data
// spends it, and the receiver hands credit back only once its sink
// has CONSUMED the bytes (the adapter reports that from the stream's
// write callback), so backpressure crosses the wire end to end. A
// sender out of credit queues and asks its source to pause; credit
// arriving flushes the queue and resumes it.
//
// Pure: Uint8Array in, Uint8Array out, no node builtins, so the
// browser transport carries it unchanged (a browser never opens a
// channel, but it must not choke on the code).

// Frame layout: 1 byte kind, 16 bytes channel id, then the payload.
// The id is the 32-hex client-minted id (shared/ipc/hexId.ts) as raw
// bytes, so a channel frame is 17 bytes of header, whatever it says.
export const CHANNEL_ID_BYTES = 16;
export const CHANNEL_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;

export const CHANNEL_FRAME_DATA = 1;
export const CHANNEL_FRAME_END = 2;
export const CHANNEL_FRAME_RESET = 3;
export const CHANNEL_FRAME_CREDIT = 4;

// Credit each direction starts with. Sized like the byte-conn buffers
// it replaces (4 MiB high-water marks on both ends).
export const CHANNEL_WINDOW_BYTES = 4 * 1024 * 1024;
// Largest data payload per frame. Comfortably under the host's inbound
// frame cap (MAX_INBOUND_FRAME_BYTES, 1 MiB) with the header on top.
export const CHANNEL_MAX_FRAME_BYTES = 256 * 1024;
// A receiver counts bytes in flight (sent by the peer, not yet
// consumed here); a peer that overshoots its credit by more than one
// frame is broken and its channel is reset.
const CHANNEL_OVERRUN_SLACK_BYTES = CHANNEL_MAX_FRAME_BYTES;

export type ChannelFrame = {
  kind: number;
  channelId: string;
  payload: Uint8Array;
};

const HEX = "0123456789abcdef";

function idToBytes(channelId: string, into: Uint8Array, offset: number): void {
  for (let i = 0; i < CHANNEL_ID_BYTES; i++) {
    into[offset + i] = parseInt(channelId.slice(i * 2, i * 2 + 2), 16);
  }
}

function bytesToId(bytes: Uint8Array, offset: number): string {
  let id = "";
  for (let i = 0; i < CHANNEL_ID_BYTES; i++) {
    const byte = bytes[offset + i] as number;
    id += HEX[byte >> 4] as string;
    id += HEX[byte & 0x0f] as string;
  }
  return id;
}

export function encodeChannelFrame(
  kind: number,
  channelId: string,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(CHANNEL_HEADER_BYTES + payload.length);
  frame[0] = kind;
  idToBytes(channelId, frame, 1);
  frame.set(payload, CHANNEL_HEADER_BYTES);
  return frame;
}

// null for anything that is not a well-formed channel frame.
export function decodeChannelFrame(bytes: Uint8Array): ChannelFrame | null {
  if (bytes.length < CHANNEL_HEADER_BYTES) return null;
  const kind = bytes[0] as number;
  if (
    kind !== CHANNEL_FRAME_DATA &&
    kind !== CHANNEL_FRAME_END &&
    kind !== CHANNEL_FRAME_RESET &&
    kind !== CHANNEL_FRAME_CREDIT
  ) {
    return null;
  }
  return {
    kind,
    channelId: bytesToId(bytes, 1),
    payload: bytes.subarray(CHANNEL_HEADER_BYTES),
  };
}

function encodeCredit(bytes: number): Uint8Array {
  const payload = new Uint8Array(4);
  payload[0] = (bytes >>> 24) & 0xff;
  payload[1] = (bytes >>> 16) & 0xff;
  payload[2] = (bytes >>> 8) & 0xff;
  payload[3] = bytes & 0xff;
  return payload;
}

function decodeCredit(payload: Uint8Array): number | null {
  if (payload.length !== 4) return null;
  return (
    (((payload[0] as number) << 24) |
      ((payload[1] as number) << 16) |
      ((payload[2] as number) << 8) |
      (payload[3] as number)) >>>
    0
  );
}

// The local side of a channel, supplied by whoever attaches it.
export type ChannelEndpoint = {
  // Bytes from the peer. Call `consumed` once the sink has taken them
  // (a stream's write callback): that is what returns credit to the
  // peer, so calling it early defeats backpressure.
  onData(data: Uint8Array, consumed: () => void): void;
  // The peer ended its direction. Nothing more arrives; this side may
  // still write until it ends too.
  onEnd(): void;
  // The peer reset the channel (or the socket died). Both directions
  // are over and the channel is gone.
  onReset(): void;
  // The peer's credit let a paused source continue: every queued byte
  // has been sent, so the source may resume.
  onWritable(): void;
};

// What the attaching side drives.
export type ChannelHandle = {
  readonly channelId: string;
  // Queues and sends within credit. Returns false when bytes stayed
  // queued for lack of credit: pause the source until onWritable.
  write(data: Uint8Array): boolean;
  // Ends this direction once the queue drains.
  end(): void;
  // Tears the channel down now, both directions, dropping any queue.
  // A no-op once the channel is already gone.
  reset(): void;
  // Whether the channel is still registered (neither reset nor fully
  // ended).
  readonly open: boolean;
};

export type ChannelMux = {
  // Registers a channel under a client-minted id. Throws when the id
  // is already attached.
  attach(channelId: string, endpoint: ChannelEndpoint): ChannelHandle;
  // Routes one inbound binary frame. Returns false for a frame that
  // is malformed or names no attached channel (the caller may log).
  handleFrame(bytes: Uint8Array): boolean;
  has(channelId: string): boolean;
  size(): number;
  // The socket is gone: every endpoint sees a reset and the registry
  // empties. No frames are sent.
  closeAll(): void;
};

export function createChannelMux(deps: {
  // Sends one binary frame on the socket. Throws when the socket is
  // gone; the mux swallows that, since the socket's close resets every
  // channel anyway.
  send(frame: Uint8Array<ArrayBuffer>): void;
}): ChannelMux {
  type Channel = {
    endpoint: ChannelEndpoint;
    handle: ChannelHandle;
    // Sending side.
    credit: number;
    queue: Uint8Array[];
    queuedBytes: number;
    paused: boolean;
    ending: boolean;
    sentEnd: boolean;
    // Receiving side.
    inFlight: number;
    receivedEnd: boolean;
    gone: boolean;
  };
  const channels = new Map<string, Channel>();

  function send(kind: number, channelId: string, payload?: Uint8Array): void {
    try {
      deps.send(encodeChannelFrame(kind, channelId, payload));
    } catch {
      // The socket is closing; its close will reset every channel.
    }
  }

  function remove(channelId: string, channel: Channel): void {
    channel.gone = true;
    channel.queue = [];
    channel.queuedBytes = 0;
    if (channels.get(channelId) === channel) channels.delete(channelId);
  }

  // Both directions ended cleanly: the channel is complete.
  function maybeComplete(channelId: string, channel: Channel): void {
    if (channel.sentEnd && channel.receivedEnd) remove(channelId, channel);
  }

  function flush(channelId: string, channel: Channel): void {
    while (channel.queue.length > 0 && channel.credit > 0 && !channel.gone) {
      const head = channel.queue[0] as Uint8Array;
      const take = Math.min(
        head.length,
        channel.credit,
        CHANNEL_MAX_FRAME_BYTES,
      );
      if (take === head.length) channel.queue.shift();
      else channel.queue[0] = head.subarray(take);
      channel.queuedBytes -= take;
      channel.credit -= take;
      send(CHANNEL_FRAME_DATA, channelId, head.subarray(0, take));
    }
    if (channel.queue.length === 0 && channel.ending && !channel.sentEnd) {
      channel.sentEnd = true;
      send(CHANNEL_FRAME_END, channelId);
      maybeComplete(channelId, channel);
    }
    if (channel.queue.length === 0 && channel.paused && !channel.gone) {
      channel.paused = false;
      channel.endpoint.onWritable();
    }
  }

  return {
    attach(channelId, endpoint) {
      if (channels.has(channelId)) {
        throw new Error(`channel ${channelId} is already attached`);
      }
      const channel: Channel = {
        endpoint,
        handle: undefined as unknown as ChannelHandle,
        credit: CHANNEL_WINDOW_BYTES,
        queue: [],
        queuedBytes: 0,
        paused: false,
        ending: false,
        sentEnd: false,
        inFlight: 0,
        receivedEnd: false,
        gone: false,
      };
      channel.handle = {
        channelId,
        get open() {
          return !channel.gone;
        },
        write(data) {
          if (channel.gone || channel.ending) return true;
          if (data.length > 0) {
            channel.queue.push(data);
            channel.queuedBytes += data.length;
          }
          flush(channelId, channel);
          if (channel.queue.length > 0) {
            channel.paused = true;
            return false;
          }
          return true;
        },
        end() {
          if (channel.gone || channel.ending) return;
          channel.ending = true;
          flush(channelId, channel);
        },
        reset() {
          if (channel.gone) return;
          remove(channelId, channel);
          send(CHANNEL_FRAME_RESET, channelId);
        },
      };
      channels.set(channelId, channel);
      return channel.handle;
    },

    handleFrame(bytes) {
      const frame = decodeChannelFrame(bytes);
      if (frame === null) return false;
      const channel = channels.get(frame.channelId);
      if (channel === undefined) return false;
      switch (frame.kind) {
        case CHANNEL_FRAME_DATA: {
          if (channel.receivedEnd) return false;
          const length = frame.payload.length;
          channel.inFlight += length;
          if (
            channel.inFlight >
            CHANNEL_WINDOW_BYTES + CHANNEL_OVERRUN_SLACK_BYTES
          ) {
            // The peer ignored its credit: a broken sender, not a
            // slow one. Reset rather than buffer without bound.
            remove(frame.channelId, channel);
            send(CHANNEL_FRAME_RESET, frame.channelId);
            channel.endpoint.onReset();
            return true;
          }
          let credited = false;
          channel.endpoint.onData(frame.payload, () => {
            if (credited) return;
            credited = true;
            channel.inFlight -= length;
            if (!channel.gone && length > 0) {
              send(CHANNEL_FRAME_CREDIT, frame.channelId, encodeCredit(length));
            }
          });
          return true;
        }
        case CHANNEL_FRAME_END:
          if (channel.receivedEnd) return false;
          channel.receivedEnd = true;
          channel.endpoint.onEnd();
          maybeComplete(frame.channelId, channel);
          return true;
        case CHANNEL_FRAME_RESET:
          remove(frame.channelId, channel);
          channel.endpoint.onReset();
          return true;
        case CHANNEL_FRAME_CREDIT: {
          const amount = decodeCredit(frame.payload);
          if (amount === null) return false;
          channel.credit = Math.min(
            channel.credit + amount,
            CHANNEL_WINDOW_BYTES,
          );
          flush(frame.channelId, channel);
          return true;
        }
        default:
          return false;
      }
    },

    has: (channelId) => channels.has(channelId),
    size: () => channels.size,

    closeAll() {
      const all = [...channels.entries()];
      channels.clear();
      for (const [, channel] of all) {
        channel.gone = true;
        channel.queue = [];
        channel.endpoint.onReset();
      }
    },
  };
}
