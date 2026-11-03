// A peer's worktree gone (its worktrees:removal): the mirrors into it
// running here end, and the originals here whose copy was deleted on
// its device while the two were in step go too, forced, since that
// delete stood for both. Each goes only if it still holds what this
// device read of it when the two were found in step (`expect`, checked
// before its scripts stop and again right before its files go), and only
// under the command switch, as the peer's own delete call here would be.
// One that stays says why on its thread.
import { hubContract } from "@shigomori/contracts/modules/hub";
import { messageOf } from "@shigomori/engine/errorDocument";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HostAccount from "@host/lib/HostAccount";
import * as HostPushes from "@host/lib/HostPushes";
import * as Worktrees from "@host/lib/Worktrees";
import { log } from "@shared/log";
import type { Taken } from "./ledger/peers";
import { MirrorEngine } from "./MirrorEngine";
import { MirrorLedger } from "./MirrorLedger";

const ORIGINAL_KEPT_DETAIL =
  "The two were in step when the copy was deleted, but this worktree changed since or couldn't be deleted, so it stays.";

const ORIGINAL_CONTROL_OFF_DETAIL =
  "The two were in step when the copy was deleted, but control from other devices is off here, so this worktree stays.";

const deleteOriginals = (originals: readonly Taken[]) =>
  Effect.gen(function* () {
    const engine = yield* MirrorEngine;
    const stays = (worktreeId: string, detail: string) =>
      engine.noteEvent(worktreeId, "stopped", detail);
    const { facts } = yield* (yield* HostAccount.HostAccount).current;
    if (facts?.acceptsCommands !== true) {
      for (const original of originals) {
        stays(original.worktreeId, ORIGINAL_CONTROL_OFF_DETAIL);
      }
      return;
    }
    const worktrees = yield* Worktrees.Worktrees;
    yield* Effect.forEach(
      originals,
      (original) =>
        Effect.map(
          Effect.exit(
            worktrees.remove(
              { ...original, force: true, oneSide: true },
              () => {},
            ),
          ),
          (removed) => {
            const stayed = Exit.isFailure(removed)
              ? messageOf(Cause.squash(removed.cause))
              : removed.value.ok
                ? undefined
                : `its ${removed.value.cleanupError.phase} step failed`;
            if (stayed === undefined) return;
            log.warn(
              `[mirror] the original of a deleted copy stayed: ${stayed}`,
            );
            stays(original.worktreeId, ORIGINAL_KEPT_DETAIL);
          },
        ),
      { discard: true },
    );
  });

// Each removal on its own, so one waiting on a cleanup holds no other.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ledger = yield* MirrorLedger;
    const removals = yield* FiberSet.make();
    const peerPushes = yield* HostPushes.payloads(hubContract, "peerPush");
    yield* peerPushes.pipe(
      Stream.filter((push) => push.channel === "worktrees:removal"),
      Stream.runForEach((push) =>
        FiberSet.run(
          removals,
          ledger
            .endMirrorsOnPeerRemoval(push.deviceId, push.payload)
            .pipe(Effect.flatMap(deleteOriginals)),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
