// The terminal's cross-device verbs on the loopback (host/lib/control/ops.ts).
import type { controlContract } from "@shigomori/contracts/modules/control";
import type { SyncPullProgress } from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shigomori/contracts/types";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  bring,
  clone,
  devices,
  mirrors,
  mirrorStop,
  peerWorktrees,
  send,
} from "@host/lib/control/ops";
import { access, setAccess } from "@host/lib/control/access";

export const controlHandlers = {
  devices,
  peerWorktrees,
  mirrors,
  mirrorStop,
  access,
  setAccess,
} satisfies EffectHandlers<
  typeof controlContract,
  HandlerContext,
  HostServices
>;

// A transfer or a clone as its caller follows it: each step of its
// progress as the op notifies it, then its answer, on one stream.
// Interrupting the stream (the caller gone) interrupts the op.
type Followed<A> =
  | { readonly _tag: "progress"; readonly progress: SyncPullProgress }
  | { readonly _tag: "result"; readonly result: A };

const followTransfer =
  <I, A>(
    op: (
      input: I,
      ctx: HandlerContext,
    ) => Effect.Effect<A, unknown, HostServices>,
  ) =>
  (input: unknown): Stream.Stream<Followed<A>, unknown, HostServices> =>
    Stream.callback<Followed<A>, unknown, HostServices>((queue) =>
      Effect.gen(function* () {
        const abort = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
        const ctx: HandlerContext = {
          connection: abort.signal,
          notifier: () => (progress) =>
            Queue.offerUnsafe(queue, {
              _tag: "progress",
              progress: progress as SyncPullProgress,
            }),
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
  clone: followTransfer(clone),
};
