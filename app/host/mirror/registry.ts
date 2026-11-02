// The vocabulary around the mirror daemon (MirrorEngine.ts): the labels
// the start orchestration writes on a session, the raw shapes the daemon
// reports, and the ways to reach it. What this host does with the
// sessions, and keeps about them while it does, is the ledger's
// (MirrorLedger.ts).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { access } from "node:fs/promises";
import { unmountedVolume } from "@shared/unmountedVolume";
import {
  MIRROR_LABEL_MODE,
  MIRROR_LABEL_REPLACES,
  type MirrorSessionRaw,
  mirrorEngineBlocker,
} from "@shigomori/contracts/modules/mirror";
import {
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
} from "@shigomori/contracts/modules/sync";
import { MirrorEngine, MirrorError } from "@host/mirror/MirrorEngine";

// The label keys the start orchestration writes on a session, lifted
// back out for the renderer by annotate below. Labels are the one
// free-form slot Mutagen persists with a session, so they survive a
// daemon restart without any bookkeeping of our own. Ids only: the
// engine refuses label values outside its alphabet, and the branch is
// the local worktree's to report.
export const MIRROR_LABEL_LOCAL_PROJECT = "localProjectId";

// The ignore rule the session was opened with (a MirrorIgnoreMode),
// so the page can say which rule its patterns came from. Absent on a
// session that predates it, which read as "everything".
export const MIRROR_LABEL_IGNORE_MODE = "ignoreMode";

// What kind of session it is (MIRROR_LABEL_MODE), or null for a mode
// this build does not know. A v2 session's labels are rewritten into a
// mode when the daemon loads it (file-sync/engine.go relabelV2Sessions).
type MirrorMode = "mirror" | "mirror-branch" | `transfer-${string}`;

const TRANSFER_PREFIX = "transfer-";

function modeOf(labels: Record<string, string>): MirrorMode | null {
  const mode = labels[MIRROR_LABEL_MODE];
  return mode === "mirror" ||
    mode === "mirror-branch" ||
    mode?.startsWith(TRANSFER_PREFIX) === true
    ? (mode as MirrorMode)
    : null;
}

export const transferModeFor = (token: string): MirrorMode =>
  `${TRANSFER_PREFIX}${token}`;

// The transfer's token, or null for a session that is not a transfer.
export function transferTokenOf(labels: Record<string, string>): string | null {
  const mode = modeOf(labels);
  return mode?.startsWith(TRANSFER_PREFIX) === true
    ? mode.slice(TRANSFER_PREFIX.length)
    : null;
}

export const isTransferSession = (session: {
  labels: Record<string, string>;
}): boolean => transferTokenOf(session.labels) !== null;

export const onMirrorBranch = (session: {
  labels: Record<string, string>;
}): boolean => modeOf(session.labels) === "mirror-branch";

// The labels of the session that replaces `raw` on the same pair (a
// re-open, a moved worktree): its own carried over, and the session it
// replaces.
export function carriedLabels(
  raw: MirrorSessionRaw,
  changes: Record<string, string>,
): Record<string, string> {
  return {
    ...raw.labels,
    [MIRROR_LABEL_REPLACES]: raw.session,
    ...changes,
  };
}

// What the daemon reports for one session, before annotation
// (contracts' modules/mirror.ts), re-exported for the host's own callers.
export type { MirrorSessionRaw };

// The ignore mode a session's labels carry, "everything" when none.
const isMirrorIgnoreMode = Schema.is(MirrorIgnoreModeSchema);
export function ignoreModeOf(labels: Record<string, string>): MirrorIgnoreMode {
  const mode = labels[MIRROR_LABEL_IGNORE_MODE];
  return isMirrorIgnoreMode(mode) ? mode : "everything";
}

// The engine when it can take a session, or the reason it cannot:
// the mirror start and the transplant's file transfer both begin here.
export const requireRunningEngine = Effect.flatMap(MirrorEngine, (daemon) =>
  Effect.flatMap(
    Effect.all([daemon.status, daemon.failure]),
    ([status, failure]) => {
      const blocker = mirrorEngineBlocker(status, undefined, failure);
      return blocker === undefined
        ? Effect.succeed(daemon)
        : Effect.fail(new MirrorError({ reason: blocker }));
    },
  ),
);

// The daemon, or null where none is provided, for a caller that has a
// sensible answer without one.
export const engineOrNull = Effect.map(
  Effect.serviceOption(MirrorEngine),
  Option.getOrNull,
);

// The daemon when it is running, or null: one restarting or still
// starting mirrors nothing a sweep could end.
export const runningEngine = Effect.flatMap(engineOrNull, (daemon) =>
  daemon === null
    ? Effect.succeed(null)
    : Effect.map(daemon.status, (status) =>
        status === "running" ? daemon : null,
      ),
);

// The daemon's sessions that ARE mirrors: a transplant's one-shot
// transfer (host/mirror/oneShot.ts) rides the same daemon under a
// label, and nothing that lists, follows or narrates mirrors should
// see it. The transfer finds its own session on the raw list. Nor a
// session in a mode this build does not know.
export const mirrorSessions = (
  daemon: Pick<MirrorEngine["Service"], "sessions">,
) =>
  Effect.map(daemon.sessions, (sessions) =>
    sessions.filter((raw) => {
      const mode = modeOf(raw.labels);
      return mode === "mirror" || mode === "mirror-branch";
    }),
  );

export const findSession = (daemon: MirrorEngine["Service"], session: string) =>
  Effect.map(daemon.sessions, (sessions) =>
    sessions.find((raw) => raw.session === session),
  );

// Whether a session's root is still there. Only "no such file" says it
// is gone, and not on a volume that isn't mounted (a drive unplugged,
// asleep, not mounted yet), whose every path reads as none: a folder
// macOS has not granted this app fails the look too, and neither may
// end a mirror.
export const rootExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) =>
      error.code !== "ENOENT" || unmountedVolume(path) !== null,
  );

// Whether anything is at a path the look can see. One it can't (its
// volume not mounted) reads as nothing there.
export const pathVisible = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

export const STOPPED_WAITING_DETAIL =
  "This worktree moved, and its mirror was stopped before the other device could be reached to re-open it. The copy on the other device stays as a worktree.";

export const ORIGINAL_GONE_DETAIL =
  "This worktree was removed outside the app, so the mirror ended. The copy on the other device stays as a worktree.";

export const LEFT_ACCOUNT_DETAIL =
  "This device left the account. The copy stays as a worktree.";
