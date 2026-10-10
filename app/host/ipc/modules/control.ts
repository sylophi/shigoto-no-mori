// The terminal's cross-device verbs on the loopback (host/lib/control/ops.ts).
import type {
  ControlTransferEvent,
  controlContract,
} from "@shigomori/contracts/modules/control";
import type { HandlerContext } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
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
} satisfies EffectHandlers<
  typeof controlContract,
  HandlerContext,
  HostServices
>;

// A transfer as its caller follows it: each step of its progress as the
// op notifies it, then its answer, on one stream. Interrupting the
// stream (the caller gone) aborts the op's signal.
export const followTransfer =
  <I>(
    op: (
      input: I,
      ctx: HandlerContext,
    ) => Effect.Effect<
      Extract<ControlTransferEvent, { _tag: "result" }>["result"],
      unknown,
      HostServices
    >,
  ) =>
  (
    input: unknown,
  ): Stream.Stream<ControlTransferEvent, unknown, HostServices> =>
    Stream.callback<ControlTransferEvent, unknown, HostServices>((queue) =>
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
        const settled = yield* Effect.result(op(input as I, ctx));
        if (Result.isFailure(settled)) {
          return yield* Queue.fail(queue, settled.failure);
        }
        Queue.offerUnsafe(queue, { _tag: "result", result: settled.success });
        yield* Queue.end(queue);
      }),
    );

export const controlTransfers = {
  send: followTransfer(send),
  bring: followTransfer(bring),
};
