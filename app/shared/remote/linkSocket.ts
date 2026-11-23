// A Colibrii link (@colibrii/sdk) as the socket sm's RPC runs on, at
// either end: open from the start, each app message one frame, and
// closed as the link is. The link stays the caller's to close, unless a
// read or a write fails, which ends it.
import type { Link } from "@colibrii/sdk";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

type Listener = (event: Socket.WebSocketEvent) => void;
type EventType = "open" | "message" | "error" | "close";

const encoder = new TextEncoder();

export const linkSocket = (
  link: Link,
): Effect.Effect<Socket.WebSocketLike, never, Scope.Scope> =>
  Effect.gen(function* () {
    const listeners = new Map<EventType, Set<Listener>>(
      (["open", "message", "error", "close"] as const).map((type) => [
        type,
        new Set(),
      ]),
    );
    const emit = (type: EventType, event: Socket.WebSocketEvent) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    let readyState = 1;
    // One sender, so the frames go in the order they were sent.
    const outbound = yield* Queue.unbounded<Uint8Array>();
    yield* Stream.fromQueue(outbound).pipe(
      Stream.runForEach((frame) => link.send(frame)),
      Effect.catchCause(() => link.close),
      Effect.forkScoped,
    );
    yield* link.messages.pipe(
      Stream.runForEach((data) =>
        Effect.sync(() => emit("message", { type: "message", data })),
      ),
      Effect.catchCause(() => link.close),
      Effect.andThen(link.closed),
      Effect.flatMap(({ code, cause }) =>
        Effect.sync(() => {
          readyState = 3;
          emit("close", { type: "close", code, reason: cause });
        }),
      ),
      Effect.forkScoped,
    );
    const socket: Socket.WebSocketLike = {
      get readyState() {
        return readyState;
      },
      addEventListener(type, listener, options) {
        const set = listeners.get(type);
        if (set === undefined) return;
        if (options?.once !== true) {
          set.add(listener);
          return;
        }
        const once: Listener = (event) => {
          set.delete(once);
          listener(event);
        };
        set.add(once);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      send(data) {
        if (readyState !== 1) return;
        Queue.offerUnsafe(
          outbound,
          typeof data === "string" ? encoder.encode(data) : data,
        );
      },
      close() {
        if (readyState !== 1) return;
        readyState = 2;
        Effect.runFork(link.close);
      },
    };
    return socket;
  });
