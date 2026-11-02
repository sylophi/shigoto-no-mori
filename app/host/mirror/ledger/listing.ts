// A device's mirror picture: the daemon's sessions with what the
// starts, the stops and the served streams under way add to them, read
// once a window after anything in it moved (a daemon snapshot, a
// follower's verdict, a thread's event, a start, a stop or a served
// stream), for the host's view and the changed push alike.
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type {
  MirrorListResult,
  MirrorSession,
  MirrorStarting,
} from "@shigomori/contracts/modules/mirror";
import * as Views from "@host/lib/Views";
import { MirrorEngine } from "../MirrorEngine";
import { annotateMirrorSession } from "../plan";
import { mirrorSessions } from "../registry";
import type { Streams } from "./streams";

// The daemon snapshots on every cycle of every session and the follower
// reports every verdict, so the picture is read once a window this long
// after the first change of a burst: a busy mirror costs viewers one
// re-read per beat, not one per cycle.
const PICTURE_WINDOW_MS = 150;

// That something the picture shows may have moved, told from callbacks,
// so the tell is synchronous. One change waiting is all a burst needs,
// and the view's one shared read is its one reader.
export const makeChanges = Effect.gen(function* () {
  const queue = yield* Queue.sliding<void>(1);
  return {
    changed: (): void => {
      Queue.offerUnsafe(queue, undefined);
    },
    changes: Stream.fromQueue(queue),
  };
});

export type Changes = Effect.Success<typeof makeChanges>;

export const makeListing = ({
  changes,
  streams,
}: {
  readonly changes: Changes;
  readonly streams: Streams;
}) =>
  Effect.sync(() => {
    // The sessions a stop has ended whose copy is still being removed,
    // as last listed. The engine drops a session at terminate, and the
    // copy's delete follows for seconds. Listed through that, the pair
    // keeps reading as one worktree (the sidebar folds it, the page keeps
    // its pill) instead of the copy surfacing as a worktree of its own
    // until it vanishes.
    const stopping = new Map<string, MirrorSession>();

    // The mirrors being started whose copy already exists, by the
    // original's worktree id: the copy lists from its create on, through
    // its setup and the first pass, and the session only opens after.
    // Listed through that, the pair reads as one worktree from the start
    // too. A start that went through gives its place up to the session
    // once the engine lists it, which is a state event after the create
    // answers.
    const starting = new Map<string, MirrorStarting>();

    // A device's mirror picture: what mirror:list answers and what
    // mirror:changed carries. The same for every caller. A daemon that is
    // restarting lists the sessions it had, which come back with it, under
    // the daemon status that says why nothing moves.
    const list = () =>
      Effect.gen(function* () {
        const daemon = yield* MirrorEngine;
        const status = yield* daemon.status;
        const sessions = (yield* mirrorSessions(daemon)).map((raw) =>
          annotateMirrorSession(raw, daemon.gitStatus(raw.session)),
        );
        const live = new Set(sessions.map((session) => session.session));
        for (const session of sessions) {
          starting.delete(session.localWorktreeId);
        }
        for (const [id, session] of stopping) {
          if (!live.has(id)) sessions.push(session);
        }
        return {
          daemon: status,
          daemonFailure: yield* daemon.failure,
          sessions,
          serving: streams.listServing(),
          starting: [...starting.values()],
        } satisfies MirrorListResult;
      });

    // The picture now, then each one read after a change that differs:
    // one read for every window, peer and the changed push.
    const watch = Views.view("mirror:watch", list, () => false, {
      also: Effect.succeed(
        changes.changes.pipe(Stream.groupedWithin(Infinity, PICTURE_WINDOW_MS)),
      ),
    });

    const noteStarting = (entry: MirrorStarting): void => {
      if (
        starting.get(entry.localWorktreeId)?.worktreeId === entry.worktreeId
      ) {
        return;
      }
      starting.set(entry.localWorktreeId, entry);
      changes.changed();
    };

    const forgetStarting = (localWorktreeId: string): void => {
      if (starting.delete(localWorktreeId)) changes.changed();
    };

    const whileStopping = <A, E, R>(
      session: string,
      shown: MirrorSession,
      run: Effect.Effect<A, E, R>,
    ) =>
      Effect.sync(() => stopping.set(session, shown)).pipe(
        Effect.andThen(run),
        Effect.ensuring(
          Effect.sync(() => {
            stopping.delete(session);
            changes.changed();
          }),
        ),
      );

    return {
      changed: changes.changed,
      list,
      watch,
      noteStarting,
      forgetStarting,
      whileStopping,
    };
  });
