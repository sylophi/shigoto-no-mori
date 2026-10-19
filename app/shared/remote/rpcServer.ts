// The server's half of the link protocol both of its servers speak: the
// shell's over ports (main/ipc/ShellLink.ts) and the host's over sockets
// (host/socket/DeviceLink.ts). Effect's binary layout, the requests
// written in, the disconnects and the protocol's options. Each server
// keeps its connections and reads them itself.
import { LINK_MAX_FRAME_BYTES } from "@shigomori/contracts/link";
import * as Effect from "effect/Effect";
import * as SchemaBinary from "effect/encoding/SchemaBinary";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

// A client as the protocol answers it: its parser and its wire, or none
// once it is gone.
export type ServedClient = {
  readonly parser: RpcSerialization.Parser;
  readonly send: (encoded: Uint8Array<ArrayBuffer>) => void;
};

export const makeServerProtocol = (options: {
  readonly client: (clientId: number) => ServedClient | undefined;
  readonly clientIds: () => ReadonlySet<number>;
}) =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization.pipe(
      Effect.provide(
        RpcSerialization.layerSchemaBinary({
          maxFrameSize: LINK_MAX_FRAME_BYTES,
        }),
      ),
    );
    const disconnects = yield* Queue.unbounded<number>();
    let writeRequest!: (
      clientId: number,
      message: RpcMessage.FromClientEncoded,
    ) => Effect.Effect<void>;
    const protocol = yield* RpcServer.Protocol.make((write) => {
      writeRequest = write;
      return Effect.succeed({
        disconnects,
        send: (clientId, response) =>
          Effect.sync(() => {
            const client = options.client(clientId);
            const encoded = client?.parser.encode(response);
            if (client !== undefined && encoded !== undefined) {
              client.send(encoded as Uint8Array<ArrayBuffer>);
            }
          }),
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set(options.clientIds())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: serialization.codecFor,
      } satisfies Omit<RpcServer.Protocol["Service"], "run">);
    });
    return {
      protocol,
      parser: () => serialization.makeUnsafe(),
      request: (clientId: number, message: RpcMessage.FromClientEncoded) =>
        writeRequest(clientId, message),
      disconnected: (clientId: number) =>
        Queue.offerUnsafe(disconnects, clientId),
    };
  });

// A frame's requests, or why the parser couldn't read it.
export function decodeFrame(
  parser: RpcSerialization.Parser,
  frame: Uint8Array | string,
): Result.Result<ReadonlyArray<RpcMessage.FromClientEncoded>, unknown> {
  try {
    return Result.succeed(
      parser.decode(frame) as ReadonlyArray<RpcMessage.FromClientEncoded>,
    );
  } catch (error) {
    return Result.fail(error);
  }
}

// A whole message's requests, for a wire that keeps messages whole: read
// alone, with layerSchemaBinary's envelope, so a frame cut short or a bad
// frame after a good one fails here and not in the next message.
export function decodeMessage(
  message: Uint8Array | string,
): Result.Result<ReadonlyArray<RpcMessage.FromClientEncoded>, unknown> {
  const parser = SchemaBinary.parser(RpcMessage.EncodedSchema, {
    fingerprint: true,
    maxFrameSize: LINK_MAX_FRAME_BYTES,
  });
  try {
    const messages = parser.feedSync(
      typeof message === "string" ? new TextEncoder().encode(message) : message,
    );
    parser.endSync();
    return Result.succeed(
      messages as ReadonlyArray<RpcMessage.FromClientEncoded>,
    );
  } catch (error) {
    return Result.fail(error);
  }
}

// What a dropped frame says in a log: its size and the parse error,
// never its bytes, which can carry a token.
export const frameWords = (frame: Uint8Array | string, error: unknown) =>
  `${typeof frame === "string" ? frame.length : frame.byteLength} bytes: ${(error instanceof
  Error
    ? error.message
    : String(error)
  ).replaceAll(/\s*\n\s*/g, " ")}`;
