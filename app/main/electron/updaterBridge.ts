// The updater's on-disk bridge to the CLI. `sm update` reaches the
// shell's updater through the data dir rather than the host's
// loopback, so it works while the host is down too: the app publishes
// its updater state to updater.json ({ pid, appVersion, state,
// handoff }) on boot and on every state change, and takes the install
// request in updater-request.json ({ action, id, appPid, requesterPid })
// the CLI writes, saying what became of it in `handoff`. The request is
// looked for every second from boot on, not watched for: the data dir
// holds the worktrees, and under their churn macOS's FSEvents drops
// events, which Node's fs.watch passes over in silence. A failed
// publish degrades `sm update`, never the updater itself.
import path from "node:path";
import { app } from "electron";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type {
  UpdateHandoff,
  UpdaterState,
  UpdaterStatus,
} from "@shigomori/contracts/schemas";
import { UpdateRequestSchema } from "@shigomori/contracts/schemas";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { updaterFiles } from "@shigomori/engine/Updater";
import { dataDir } from "@shared/paths";
import { readJson, writeJson } from "../core/files/jsonFile";

const REQUEST_POLL_MS = 1000;

const files = () => updaterFiles(path, dataDir());

// One publish at a time: setState can fire twice in one tick (a
// synchronous throw right after entering "checking"), and two racing
// writes could land out of order, freezing the file on the older state.
const publishing = Semaphore.makeUnsafe(1);

// The last state and the last request's fate, published together.
let state: UpdaterState = { kind: "idle" };
let handoff: UpdateHandoff | undefined;
// Once the data dir is let go of, nothing writes into it again.
let released = false;

// What is current when the write gets its turn, so the last write
// carries the latest state and the request's fate, whichever call it was.
const publish = publishing.withPermit(
  Effect.suspend(() => {
    if (released) return Effect.void;
    const status: UpdaterStatus = {
      pid: process.pid,
      appVersion: app.getVersion(),
      state,
      ...(handoff === undefined ? {} : { handoff }),
    };
    // The CLI treats a missing or stale file as "app not reachable".
    return Effect.ignore(writeJson(files().status, status));
  }),
);

export const publishUpdaterState = (next: UpdaterState) =>
  Effect.suspend(() => {
    state = next;
    return publish;
  });

const noteHandoff = (next: UpdateHandoff) =>
  Effect.suspend(() => {
    handoff = next;
    return publish;
  });

// Whether the process that wrote a request still waits on it: the
// signal 0 probe, where EPERM is a live process of another user.
const waiting = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The poll, so the data-folder move can let go of the data dir.
let polling: FiberHandle.FiberHandle | null = null;

// What an install asked for here came to: restarting, or why not.
export type InstallOutcome = "installing" | "declined" | "nothing-staged";

// Takes the requests, for the length of the scope (the updater's layer).
// A request is claimed by renaming it aside before it is read, so a fresh
// one landing mid-read keeps its own file instead of being deleted
// unread, and the claimed file always goes, since an unparseable leftover
// must not shadow the next request. Only a
// request for this app, from a CLI still waiting on it, is acted on:
// acting on a leftover would restart the app out of nowhere. A claim
// that fails for any reason but there being no request is `failed`'s,
// every poll until it clears.
export const updaterBridge = ({
  install,
  failed,
}: {
  readonly install: () => Promise<InstallOutcome>;
  readonly failed: (error: unknown) => void;
}): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installs = yield* FiberSet.make();
    const consumingPath = () => files().request + ".consuming";
    const claim = Effect.gen(function* () {
      const claimed = yield* fs.rename(files().request, consumingPath()).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(false),
        ),
      );
      if (!claimed) return null;
      const request = yield* readJson(
        consumingPath(),
        UpdateRequestSchema,
      ).pipe(Effect.orElseSucceed(() => null));
      yield* Effect.ignore(fs.remove(consumingPath(), { force: true }));
      return request;
    });
    // Whole, the claim to the install handed to its fiber: a stop waits
    // for it rather than leave a request taken and never acted on.
    const consume = Effect.gen(function* () {
      const request = yield* claim;
      if (
        request === null ||
        request.appPid !== process.pid ||
        !waiting(request.requesterPid)
      ) {
        return;
      }
      const { id } = request;
      yield* noteHandoff({ id, outcome: "claimed" });
      yield* FiberSet.run(
        installs,
        Effect.tryPromise(install).pipe(
          Effect.matchEffect({
            onSuccess: (outcome) =>
              outcome === "installing"
                ? Effect.void
                : noteHandoff({ id, outcome }),
            onFailure: (error) =>
              noteHandoff({
                id,
                outcome: "failed",
                message: errorMessageOf(error.cause),
              }),
          }),
        ),
      );
    }).pipe(
      Effect.uninterruptible,
      Effect.catch((error) => Effect.sync(() => failed(error))),
    );
    polling = yield* FiberHandle.make();
    yield* FiberHandle.run(
      polling,
      consume.pipe(Effect.repeat(Schedule.spaced(REQUEST_POLL_MS))),
    );
  });

// Before the data-folder move renames the data dir: the poll stopped,
// once a claim under way has settled, and nothing published after. The
// post-move relaunch starts a fresh bridge.
export const releaseUpdaterBridge = (): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* publishing.withPermit(
        Effect.sync(() => {
          released = true;
        }),
      );
      if (polling !== null) yield* FiberHandle.clear(polling);
      polling = null;
    }),
  );
