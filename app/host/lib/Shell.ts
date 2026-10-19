// What the host asks of the shell that started it: the few things only
// Electron's process can do (the updater and the app's own lifetime
// stay there). The root provides it over the port the shell handed
// over (process/host.ts).
import type { CallFailure } from "@shigomori/contracts/errors";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import type {
  GuideDrivePayload,
  GuideReply,
} from "@shigomori/contracts/modules/guide";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class Shell extends Context.Service<
  Shell,
  {
    // Restarts the app with nobody at it to answer a prompt: after a
    // data-folder move a peer asked for. Asked without waiting, since
    // the shell stops this process to do it.
    readonly relaunch: Effect.Effect<void>;
    // A move at this machine failed after the folder was let go: the
    // shell shows why with one way on, a restart. Asked without
    // waiting.
    readonly moveFailed: (reason: string) => Effect.Effect<void>;
    // The updater, which a peer's Settings page reads and drives here.
    // `unattended` marks a call another device made: a busy host
    // refuses it instead of prompting a screen nobody watches.
    readonly updater: {
      readonly check: Effect.Effect<void, CallFailure>;
      readonly install: (
        unattended: boolean,
      ) => Effect.Effect<void, CallFailure>;
      readonly update: (
        unattended: boolean,
      ) => Effect.Effect<void, CallFailure>;
      // Its state as the shell last reported it (process/session.ts),
      // so a peer's read is answered here without a round trip.
      readonly state: Effect.Effect<UpdaterState>;
      readonly noteState: (state: UpdaterState) => Effect.Effect<void>;
    };
    // Before a move or a reset of the data folder: the updater starts
    // nothing there from now on (null: no check or install, one under
    // way ended), or the version an install under way restarts into (""
    // when not known). A shell that can't be asked holds nothing.
    readonly holdUpdater: (
      forWhat: "move" | "reset",
    ) => Effect.Effect<string | null>;
    // A move that failed before the folder moved: the updater as it was.
    readonly resumeUpdater: Effect.Effect<void>;
    // The bridge the terminal's `sm update` asks the updater through,
    // stopped just before the folder moves. Asked without waiting.
    readonly stopUpdaterBridge: Effect.Effect<void>;
    // The v3 migration as it goes, which the shell serves its windows.
    readonly migration: (
      progress: MigrationProgress,
    ) => Effect.Effect<void, CallFailure>;
    // An action of `sm guide mcp`'s, run in the window its session
    // guides.
    readonly guide: (
      payload: GuideDrivePayload,
    ) => Effect.Effect<GuideReply, CallFailure>;
  }
>()("sm/host/Shell") {}

// An install under way, in the words a move or a reset refuses with,
// from the version holdUpdater answered.
export const installingWords = (version: string) =>
  version === ""
    ? "An update is installing, and the app restarts into it."
    : `The update to ${version} is installing, and the app restarts into it.`;
