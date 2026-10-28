// What an OS's install of the app is to the updater, between the steps
// every install shares (the feeds, the download, the staging area and
// its manifest, its lock, the handoff to a running app): a Mac's is the
// signed bundle (bundle.ts), Linux's a folder per version (versions.ts).
import type * as Effect from "effect/Effect";
import type { ReleaseInfo } from "../updateFeed.ts";
import type {
  InstallError,
  NotInBundle,
  StageError,
  UpdateInput,
} from "./documents.ts";

export type Installation = {
  // The installed app a run of `executable` belongs to, which an update
  // replaces. Anything else refuses, so a stray copy never updates the
  // install.
  readonly installed: (
    executable: string,
  ) => Effect.Effect<string, NotInBundle>;
  // What a crashed or superseded update left beside the installed app.
  readonly pruneLeftovers: (installed: string) => Effect.Effect<void>;
  // The release just downloaded (the files' `download`), unpacked into
  // their `extract` and held to the installed app and to what the feed
  // offered: the copy to stage.
  readonly unpack: (
    installed: string,
    release: ReleaseInfo,
    input: UpdateInput,
  ) => Effect.Effect<string, StageError>;
  // The staged copy of `version` put in place of the installed app.
  readonly swap: (
    staged: string,
    installed: string,
    version: string,
    pid: number,
  ) => Effect.Effect<void, InstallError>;
};
