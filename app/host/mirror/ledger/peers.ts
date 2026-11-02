// What a peer going or deleting its side does to the mirrors this
// device runs: the mirrors with a device that left the account ended,
// and the sessions into a copy it deleted ended, with the originals a
// delete of both sides takes here too, each expected to still hold what
// the copy held.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { MovedSource } from "@shigomori/contracts/schemas";
import { WorktreeRemovalSchema } from "@shigomori/contracts/schemas/worktree";
import { ageOf, stamp, type Stamp } from "@shigomori/engine/keptAnswers";
import {
  MIRROR_LABEL_LOCAL_PROJECT,
  mirrorSessions,
  runningEngine,
} from "../registry";
import type { Copy, Ends } from "./ends";
import type { Marks } from "./marks";

const COPY_GONE_DETAIL =
  "The copy on the other device was deleted or moved, so the mirror ended. This worktree stays unless the copy was deleted with the two in step.";

const GONE_COPY_MS = 2 * 60_000;

const decodeRemoval = Schema.decodeUnknownOption(WorktreeRemovalSchema);

type Original = {
  readonly projectId: string;
  readonly worktreeId: string;
};

// An original a copy's delete takes, if it still holds `expect`.
export type Taken = Original & { readonly expect: MovedSource };

export const makePeers = ({
  marks,
  ends,
}: {
  readonly marks: Marks;
  readonly ends: Ends;
}) =>
  Effect.sync(() => {
    // The originals of the mirrors that ended on a copy found gone, by
    // that copy, for its device's announcement to find: the git follower
    // can find the copy gone before the announcement that its delete
    // took both sides comes. Only a recent one counts, so a later
    // worktree at the copy's id isn't taken for it.
    const goneCopies = new Map<
      string,
      { readonly at: Stamp; readonly originals: readonly Original[] }
    >();

    // Ends every mirror with a peer `stillOnAccount` refuses (this device
    // signed out, or the peer was removed from the registry). The copy
    // stays as an ordinary worktree, unlike mirror:stop's delete: a
    // delete is only safe against a live peer confirming nothing is held
    // here alone, and the peer is exactly what is gone. The worktree's
    // thread says so. Failures are logged, not thrown. The one-shot
    // transfer sessions with such a peer go too: their tokens stay live,
    // so the orphan reaper never would, and their wait then fails the
    // transfer.
    const endMirrorsWithPeers = Effect.fn("MirrorLedger.endMirrorsWithPeers")(
      function* (
        stillOnAccount: (deviceId: string) => boolean,
        detail: string,
      ) {
        // A daemon that isn't running ends nothing: the sessions it
        // brings back are swept as they come (MirrorEngineLayer.ts
        // endSignedOut).
        const daemon = yield* runningEngine;
        if (daemon === null) return;
        yield* ends.endSessions(
          daemon,
          (yield* daemon.sessions).filter(
            (raw) => !stillOnAccount(raw.deviceId),
          ),
          "a mirror with a device that left the account",
          detail,
        );
      },
    );

    // The sessions into one of a peer's worktrees, known to be gone, end,
    // and each original's thread says why. Already ended (the stop and
    // the peer's announcement both get here), or being ended by a delete
    // here, there is nothing to do.
    const endMirrorsIntoGoneCopy = Effect.fnUntraced(function* (
      deviceId: string,
      projectId: string,
      worktreeId: string,
    ) {
      const daemon = yield* runningEngine;
      if (daemon === null) return;
      const doomed = (yield* mirrorSessions(daemon)).filter(
        (raw) =>
          raw.deviceId === deviceId &&
          raw.projectId === projectId &&
          raw.worktreeId === worktreeId &&
          !marks.endingSessions.has(raw.session),
      );
      if (doomed.length > 0) {
        const now = yield* stamp;
        for (const [key, gone] of goneCopies) {
          if (ageOf(gone.at, now) > GONE_COPY_MS) goneCopies.delete(key);
        }
        goneCopies.set(`${deviceId}:${projectId}:${worktreeId}`, {
          at: now,
          // Read before the sessions end, as their threads' ids are.
          originals: doomed.map(
            (raw): Original => ({
              projectId: raw.labels[MIRROR_LABEL_LOCAL_PROJECT] ?? "",
              worktreeId: marks.worktreeIdNow(raw),
            }),
          ),
        });
      }
      yield* ends.endSessions(
        daemon,
        doomed,
        "a mirror whose copy is gone",
        COPY_GONE_DETAIL,
      );
    });

    // A peer's announcement that one of its worktrees is gone
    // (worktrees:removal). A mirror runs on the device holding the
    // original, so a copy deleted on its own device leaves its session
    // here, halted on a far root that no longer exists. Answers the
    // originals a delete of both sides takes too.
    const endMirrorsOnPeerRemoval = Effect.fn(
      "MirrorLedger.endMirrorsOnPeerRemoval",
    )(function* (deviceId: string, payload: unknown) {
      const removal = decodeRemoval(payload);
      if (Option.isNone(removal) || removal.value.state !== "removed") {
        return [];
      }
      const { projectId, worktreeId, expect } = removal.value;
      yield* endMirrorsIntoGoneCopy(deviceId, projectId, worktreeId);
      if (expect === undefined) return [];
      const key = `${deviceId}:${projectId}:${worktreeId}`;
      const gone = goneCopies.get(key);
      goneCopies.delete(key);
      if (gone === undefined || ageOf(gone.at, yield* stamp) > GONE_COPY_MS) {
        return [];
      }
      return gone.originals.map(
        (original): Taken => ({
          projectId: original.projectId,
          worktreeId: original.worktreeId,
          expect,
        }),
      );
    });

    // A copy the peer no longer lists (deleted while this device missed
    // the announcement, or moved) ends its sessions: the stop's way out
    // when the copy cannot be confirmed in step. True when it ended them.
    const endMirrorIfCopyGone = Effect.fn("MirrorLedger.endMirrorIfCopyGone")(
      function* (copy: Copy) {
        if (!(yield* ends.copyIsGone(copy))) return false;
        yield* endMirrorsIntoGoneCopy(
          copy.deviceId,
          copy.projectId,
          copy.worktreeId,
        );
        return true;
      },
    );

    return {
      endMirrorsWithPeers,
      endMirrorsOnPeerRemoval,
      endMirrorIfCopyGone,
    };
  });
