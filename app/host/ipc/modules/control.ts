// The terminal's cross-device verbs on the loopback (host/lib/control/ops.ts).
import type {
  ControlTransferEvent,
  controlContract,
} from "@shigomori/contracts/modules/control";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shigomori/contracts/types";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  bring,
  devices,
  mirrors,
  mirrorStop,
  peerWorktrees,
  send,
} from "@host/lib/control/ops";

export const controlHandlers = {
  devices,
  peerWorktrees,
  mirrors,
  mirrorStop,
} satisfies Handlers<typeof controlContract, HandlerContext, HostServices>;

// A transfer as its caller follows it: each step of its progress as the
// op notifies it, then its answer, on one stream. Interrupting the
// stream (the caller gone) aborts the op's signal.
export const followTransfer =
  <I>(
    op: (
      input: I,
      ctx: HandlerContext,
    ) => Promise<Extract<ControlTransferEvent, { _tag: "result" }>["result"]>,
  ) =>
  (input: unknown): Stream.Stream<ControlTransferEvent, unknown> =>
    Stream.callback<ControlTransferEvent, unknown>((queue) =>
      Effect.gen(function* () {
        const abort = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
        const ctx: HandlerContext = {
          signal: abort.signal,
          connection: abort.signal,
          notifier: () => (progress) =>
            Queue.offerUnsafe(queue, {
              _tag: "progress",
              progress,
            } as ControlTransferEvent),
        };
        // Its failure as it is: the loopback sends a contract error as
        // itself, and any other with its message and code.
        const settled = yield* Effect.promise(() =>
          op(input as I, ctx).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          ),
        );
        if ("error" in settled) return yield* Queue.fail(queue, settled.error);
        const { result } = settled;
        Queue.offerUnsafe(queue, { _tag: "result", result });
        yield* Queue.end(queue);
      }),
    );

export const controlTransfers = {
  send: followTransfer(send),
  bring: followTransfer(bring),
};
