// What a worktree on another device holds, read there by that device
// over sync's source link, as a move's teardown reads its source: its
// branch at its tip and the tree of a capture of its uncommitted work.
// A delete asked of that device later expects it (`expect`), which the
// device compares with its own reading of itself, under its own ignore
// rules. A device that doesn't answer within a probe's time, or a
// worktree it can't read, gives nothing.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { MovedSource } from "@shigomori/contracts/schemas";
import { answerWithin } from "@shigomori/engine/liveness";
import { peerSource } from "@host/lib/sync/sourceLink";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";

export const peerHolding = (
  deviceId: string,
  worktree: { readonly projectId: string; readonly worktreeId: string },
  branch: string,
) =>
  answerWithin(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* peerSource(deviceId, worktree);
        const tip = yield* source.tip(branch);
        const fresh = yield* source.capture;
        if (tip === null || (fresh.captured && fresh.tree === undefined)) {
          return undefined;
        }
        return {
          branch,
          branchTip: tip,
          ...(fresh.captured && fresh.tree !== undefined
            ? { captureTree: fresh.tree }
            : {}),
        } satisfies MovedSource;
      }),
    ),
    PROBE_TIMEOUT_MS,
  ).pipe(
    Effect.map((answered) =>
      Option.isSome(answered) && Exit.isSuccess(answered.value)
        ? answered.value.value
        : undefined,
    ),
  );
