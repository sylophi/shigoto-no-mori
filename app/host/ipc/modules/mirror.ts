// Host side of continuous worktree mirroring (packages/contracts/src/modules/
// mirror.ts). The daemon that owns the sessions lives in main
// (main/core/mirror/daemon.ts, spawned and supervised there), so it arrives
// through an injected impl following the setPortForwardEngine
// precedent. This module owns the rest: the start orchestration, the
// stream open a peer drives to mirror FROM here (with the serving
// registry and the served index watcher behind it), and the git half
// a peer's follower reads and applies.
//
// start = send, then mirror. The send (sync's, reused verbatim) lands
// the worktree's branch, commits and uncommitted changes on the peer
// as a new worktree through the ordinary create, so carry-over (and
// setup, when the dialog asked for it) ride along and git agrees on
// both sides before a single file is watched. The mirror session then
// opens between the two worktrees, with almost nothing left to move.
// The session always runs HERE, on the device holding the original,
// whichever device asked for it (the copy's device asks over the
// grant, startFrom below): it reaches the copy's `file-sync serve`
// and git state through the peer's grant (openStream, gitState,
// applyGitState), which is the grant the send already needed, or
// through the invitation the copy's device left when it asked
// (host/mirror/invites.ts), which admits exactly those calls. So a
// stop always removes the peer's worktree. The copy's root path is
// read off the peer's own landing answer over the grant-gated wire,
// never taken from the caller.
//
// A primary checkout is mirrored the same way, its copy on
// mirror/<branch> in a mirror-<name> folder (shared/git/branches.ts),
// and the session labelled so the git follower reads the two branch
// names as one. Both primaries keep what they had.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { join } from "node:path";
import {
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_LABEL_MIRROR_BRANCH,
  MIRROR_LABEL_REPLACES,
  MIRROR_COPY_STAYED,
  mirrorFilesSettled,
  mirrorStopBlocker,
  mirrorStopRefusal,
  type MirrorGitStatus,
  type MirrorListResult,
  type MirrorServing,
  type MirrorSession,
  MirrorSessionSchema,
  type MirrorStartFromPayload,
  type MirrorStartToPayload,
  MirrorStartToResultSchema,
  mirrorContract,
  summarizeIgnores,
} from "@shigomori/contracts/modules/mirror";
import {
  SyncPullProgressSchema,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shigomori/contracts/types";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { spawnFileSync } from "@host/fileSync/spawn";
import { dataDir } from "@host/lib/util/paths";
import {
  peerMirrorApiFor,
  peerSyncApiFor,
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
  thisDeviceId,
} from "@host/ipc/peerSync";
import {
  forgetMirrorInvitesOf,
  inviteMirror,
  listMirrorInvites,
} from "@host/mirror/invites";
import { transferFilesOnce } from "@host/mirror/oneShot";
import { onAbort } from "@host/lib/util/abort";
import {
  findProjectAndWorktreeOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";
import {
  applyGitState,
  readGitState,
  watchIndexFile,
} from "@host/mirror/gitState";
import {
  endMirrorKeepingCopy,
  endMirrorsIntoGoneCopy,
  engine,
  engineOrNull,
  findSession,
  ORIGINAL_GONE_DETAIL,
  rootExists,
  ignoreModeOf,
  localWorktreeIdOf,
  MIRROR_LABEL_IGNORE_MODE,
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  type MirrorSessionRaw,
  mirrorSessions,
  requireRunningEngine,
} from "@host/mirror/registry";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { abortable, runMove, throwIfCancelled } from "@host/lib/sync/moves";
import { rollBackSent, sendWorktree } from "./sync";
import { log } from "@shared/log";

const decodePullProgress = Schema.decodeOption(SyncPullProgressSchema);
const decodeMirrorSession = Schema.decodeUnknownSync(MirrorSessionSchema);
const decodeMirrorStartToResult = Schema.decodeUnknownSync(
  MirrorStartToResultSchema,
);

// The daemon slot, the session labels and the raw session shapes live
// in host/mirror/registry.ts, where the worktree delete can reach them
// without importing this module (which reaches sync, which reaches
// worktrees). Re-exported so the daemon and the follower keep one
// import path.
export {
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  setMirrorImpl,
  type MirrorCreateInput,
  type MirrorImpl,
  type MirrorSessionRaw,
} from "@host/mirror/registry";

// The mirror streams this host currently serves, keyed by the calling
// device and the channel id it minted (unique per connection, so the
// pair is what identifies a stream host-wide): what mirror:list
// reports as `serving`, so a worktree shows "mirrored to <device>" on
// the machine it lives on. Entries live exactly as long as their
// channel. Each carries the served worktree's index watcher: a stage
// or unstage there is the one git change the peer's follower cannot
// learn from the git-directory watcher.
type Served = { entry: MirrorServing; stopIndexWatch: (() => void) | null };
const serving = new Map<string, Served>();
let onServingChange: (() => void) | null = null;
let onServingGitChange:
  | ((change: { projectId: string; worktreeId: string }) => void)
  | null = null;
// A peer's follower landed its side's git state on a worktree here: a
// ref move by the app's own git, which the git-directory watcher skips
// as the app's own, so main announces it like an outside one.
let onGitApplied: ((projectId: string) => void) | null = null;

export function setMirrorGitAppliedListener(
  listener: ((projectId: string) => void) | null,
): void {
  onGitApplied = listener;
}

// main installs the two broadcast hooks at boot. Before that (and in
// checks that never mount them) changes are simply unannounced.
export function setMirrorServingListener(listener: (() => void) | null): void {
  onServingChange = listener;
}

export function setMirrorGitChangedListener(
  listener:
    | ((change: { projectId: string; worktreeId: string }) => void)
    | null,
): void {
  onServingGitChange = listener;
}

export function listMirrorServing(): MirrorServing[] {
  return [...serving.values()].map((served) => served.entry);
}

function servingKey(ctx: HandlerContext, channelId: string): string {
  return `${ctx.callerDeviceId ?? ""}:${channelId}`;
}

function forgetServing(key: string): void {
  const served = serving.get(key);
  if (served === undefined) return;
  served.stopIndexWatch?.();
  serving.delete(key);
  onServingChange?.();
}

// The daemon's document with the two label-borne ids lifted to fields.
// The daemon validates each line on arrival (main/core/mirror/
// daemon.ts). This checks the annotated whole against the contract, a
// backstop for what the host attaches and for an impl that is not the
// daemon (the proofs' fakes).
function annotateMirrorSession(
  raw: MirrorSessionRaw,
  git?: MirrorGitStatus,
): MirrorSession {
  return decodeMirrorSession({
    ...raw,
    localProjectId: raw.labels[MIRROR_LABEL_LOCAL_PROJECT] ?? "",
    localWorktreeId: raw.labels[MIRROR_LABEL_LOCAL_WORKTREE] ?? "",
    ignoreMode: ignoreModeOf(raw.labels),
    ...(git === undefined ? {} : { git }),
  });
}

// A resume against a peer that is away answers with the connect's
// error after the engine has already un-paused the session and started
// its loop, which keeps retrying: that is a resume, not a failure, and
// the page shows it reconnecting. A halted session resumes the same
// way, its loop started again.
async function pauseOrResume(
  session: string,
  verb: "pause" | "resume",
  noted: "paused" | "resumed",
): Promise<void> {
  const daemon = engine();
  try {
    await daemon[verb](session);
  } catch (error) {
    const after = findSession(daemon, session);
    if (verb !== "resume" || after === undefined || after.paused) throw error;
  }
  daemon.noteEvent(localWorktreeIdOf(findSession(daemon, session)), noted, "");
}

// One mirror per worktree, held here and not only by the buttons: a
// worktree that already runs a session is mirrored, and one a peer
// mirrors into (it serves the stream, or holds the invitation of a
// mirror it asked for) is a copy, which a second mirror would chain
// off. Either start would only fail later on the branch, or worse,
// land.
function refuseMirroredWorktree(
  daemon: ReturnType<typeof engine>,
  worktreeId: string,
): void {
  if (
    mirrorSessions(daemon).some((raw) => localWorktreeIdOf(raw) === worktreeId)
  ) {
    throw new Error(
      "This worktree is already mirrored. Open its Mirror button to manage that one.",
    );
  }
  const isCopy =
    listMirrorServing().some((stream) => stream.worktreeId === worktreeId) ||
    listMirrorInvites().some(
      (invite) => invite.copy?.worktreeId === worktreeId,
    );
  if (isCopy) {
    throw new Error(
      "This worktree is a mirror's copy. Mirror the original instead.",
    );
  }
}

// Ignore changes in flight, by session: two at once (both devices'
// pages) would each open a session on the pair.
const reopening = new Set<string>();

// The sessions a stop has ended whose copy is still being removed,
// as last listed. The engine drops a session at terminate, and the
// copy's delete follows for seconds. Listed through that, the pair
// keeps reading as one worktree (the sidebar folds it, the page keeps
// its pill) instead of the copy surfacing as a worktree of its own
// until it vanishes.
const stopping = new Map<string, MirrorSession>();

// The sessions as last listed by a running daemon. A daemon that is
// restarting (a crash, the restart ladder) reports none, and the same
// sessions come back with it: listed as nothing meanwhile, every pair
// would unfold, every pill and Mirror button vanish, an open dialog
// close and the start buttons come back, for as long as the restart
// takes. So the last list stands until the daemon runs again, under
// the daemon status that says why nothing moves.
let lastListed: MirrorSession[] = [];

// A device's mirror picture: what mirror:list answers and what
// mirror:changed carries. The same for every caller.
function mirrorListOf(daemon: ReturnType<typeof engine>): MirrorListResult {
  const running = daemon.status() === "running";
  const sessions = running
    ? mirrorSessions(daemon).map((raw) =>
        annotateMirrorSession(raw, daemon.gitStatus(raw.session)),
      )
    : [...lastListed];
  if (running) lastListed = [...sessions];
  const live = new Set(sessions.map((session) => session.session));
  for (const [id, session] of stopping) {
    if (!live.has(id)) sessions.push(session);
  }
  return {
    daemon: daemon.status(),
    sessions,
    serving: listMirrorServing(),
  };
}

// The list for the changed broadcast, or undefined, which a reader
// answers by asking. Before the daemon is wired there is none to send.
// A list that fails to build is said so: this runs off a timer, where
// a throw would be the main process's uncaught exception.
export function currentMirrorList(): MirrorListResult | undefined {
  const daemon = engineOrNull();
  if (daemon === null) return undefined;
  try {
    return mirrorListOf(daemon);
  } catch (error) {
    log.warn(
      `[mirror] the changed broadcast goes without its list: ${errorMessageOf(error)}`,
    );
    return undefined;
  }
}

// The stop past the safety check: the engine ends the session, then
// the copy on the peer goes. A copy that stayed is reported, with the
// session already gone. The original here keeps its page, so its
// thread gets the line either way.
async function stopAndRemoveCopy(
  daemon: ReturnType<typeof engine>,
  session: string,
  raw: MirrorSessionRaw,
): Promise<void> {
  await daemon.terminate(session);
  const stayed = await peerWorktreesApiFor(raw.deviceId)
    .delete({
      projectId: raw.projectId,
      worktreeId: raw.worktreeId,
      force: true,
    })
    .then(
      (removed) =>
        removed.ok ? null : `its ${removed.cleanupError.phase} step failed`,
      // A forced stop of a copy that was already gone has nothing left
      // to remove.
      async (error: unknown) =>
        (await copyIsGone(raw)) ? null : errorMessageOf(error),
    );
  daemon.noteEvent(
    localWorktreeIdOf(raw),
    "stopped",
    stayed === null ? "" : "Copy on the other device kept",
  );
  if (stayed !== null) {
    throw new Error(
      `${MIRROR_COPY_STAYED} on the other device stayed: ${stayed}. Delete it from its page.`,
    );
  }
}

// Whether the peer answers, within a few seconds, that it no longer
// lists the session's copy. A peer that fails or stalls is no answer.
// A folder deleted by hand still lists until git prunes it.
const COPY_PROBE_MS = 5_000;
function copyIsGone(
  raw: Pick<MirrorSessionRaw, "deviceId" | "projectId" | "worktreeId">,
): Promise<boolean> {
  const listed = peerWorktreeOrUndefined(
    raw.deviceId,
    raw.projectId,
    raw.worktreeId,
  ).then(
    (copy) => copy === undefined,
    () => false,
  );
  const stalled = new Promise<boolean>((resolve) => {
    setTimeout(resolve, COPY_PROBE_MS, false).unref?.();
  });
  return Promise.race([listed, stalled]);
}

// A copy the peer no longer lists (deleted while this device missed
// the announcement, or moved) ends its session: the stop's way out when
// the copy cannot be confirmed in step. True when it ended them.
export async function endMirrorIfCopyGone(session: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
}): Promise<boolean> {
  if (!(await copyIsGone(session))) return false;
  await endMirrorsIntoGoneCopy(
    session.deviceId,
    session.projectId,
    session.worktreeId,
  );
  return true;
}

export const mirrorHandlers: Handlers<typeof mirrorContract, HandlerContext> = {
  list: () => mirrorListOf(engine()),

  // The mirror: one of this device's worktrees, sent to a peer and kept
  // in step with the copy made there. No leave-out rule goes to the
  // send: the session opened next carries the ignored files and keeps
  // carrying them. No session, so no copy either: the peer's copy is
  // removed (the original still holds the branch and its uncommitted
  // changes), or a retry would refuse on the branch the failed attempt
  // left behind. That removal is best effort: its own failure is
  // logged, not thrown over the real error. A cancel (sync:cancelMove,
  // by the worktree, from the caller: the copy's device when it asked
  // for the mirror) is the send's cancel while the send runs, and
  // past it the same rollback as a failed session open, the session
  // ended if the open outran the cancel.
  startTo: async (input: MirrorStartToPayload, ctx) => {
    const daemon = requireRunningEngine();
    refuseMirroredWorktree(daemon, input.worktreeId);
    const { ignoreMode, ignores, ...sendInput } = input;
    return runMove(ctx, input.worktreeId, async (signal) => {
      const { source, result: sent } = await sendWorktree(sendInput, ctx, {
        mirror: true,
        signal,
      });
      // The copy's root as the peer's landing answered it, re-parsed by
      // the send.
      const copy = sent.worktree;
      let session: string;
      try {
        throwIfCancelled(signal);
        // The copy's create ran its carry-over (and the setup script,
        // when asked), which wrote files of the peer's own into it.
        // Opened on that, the two-way session would hold every such
        // path the rule does not leave out as a conflict from its first
        // cycle (or carry a file only the copy has back here). So the
        // copy is made an exact copy of the original first, the rule's
        // paths left alone, and the session opens on two identical
        // trees.
        const replica = await transferFilesOnce(
          {
            localRoot: source.path,
            localWorktreeId: source.id,
            sourceDeviceId: input.targetDeviceId,
            sourceProjectId: copy.projectId,
            sourceWorktreeId: copy.id,
            remoteRoot: copy.path,
            name: source.branch,
            ignores,
            direction: "replica",
          },
          () => {},
          signal,
        );
        throwIfCancelled(signal);
        if (!replica.crossed) {
          throw new Error(
            `The files could not be brought in step: ${replica.error ?? "unknown error"}`,
          );
        }
        // A session the open made after the cancel is ended again.
        session = await abortable(
          signal,
          daemon.create({
            localRoot: source.path,
            deviceId: input.targetDeviceId,
            projectId: copy.projectId,
            worktreeId: copy.id,
            remoteRoot: copy.path,
            name: source.branch,
            localWorktreeId: source.id,
            labels: {
              [MIRROR_LABEL_LOCAL_PROJECT]: source.projectId,
              [MIRROR_LABEL_LOCAL_WORKTREE]: source.id,
              [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
              [MIRROR_LABEL_COPY_SIDE]: "remote",
              ...(source.isPrimary
                ? { [MIRROR_LABEL_MIRROR_BRANCH]: "1" }
                : {}),
            },
            ignores,
          }),
          (made) => daemon.terminate(made),
        );
      } catch (error) {
        await rollBackSent(input.targetDeviceId, copy);
        throw error;
      }
      daemon.noteEvent(
        source.id,
        "started",
        summarizeIgnores(ignoreMode, ignores),
      );
      return { ...sent, session };
    });
  },

  // The ask from the copy's side. The session runs on the peer, which
  // holds the original: this device invites the mirror (invites.ts),
  // then asks the peer's startTo towards here, and the peer's send,
  // stream and git half land through that invitation whatever this
  // device's switch says. The peer's progress comes back as its
  // pushes, keyed by its worktree, and is relayed to the caller. The
  // caller going away (a closed window or CLI socket aborts the
  // context) cancels the start on the peer, the way the dialog's
  // cancel does: the peer's send stops and the copy it made here goes.
  // A start that fails withdraws the invitation: the peer's rollback
  // already removed whatever landed under it.
  startFrom: async (input: MirrorStartFromPayload, ctx) => {
    const {
      sourceDeviceId,
      sourceProjectId: projectId,
      sourceWorktreeId: worktreeId,
      sourceIdentity: identity,
      ...rule
    } = input;
    const peerSync = peerSyncApiFor(sourceDeviceId);
    const notify = ctx.notifier(syncContract, "pullProgress");
    const stopRelay = peerSync.onPullProgress((frame) => {
      const parsed = decodePullProgress(frame);
      if (
        Option.isSome(parsed) &&
        parsed.value.sourceWorktreeId === worktreeId
      ) {
        notify(parsed.value);
      }
    });
    try {
      // A move like the others (runMove), so the dialog's and the
      // CLI's cancel (sync:cancelMove, by the source worktree) and a
      // caller going away both reach it, and are forwarded to the peer
      // running the send. The invitation is made inside, once the move
      // holds its key: a second ask for the same worktree is refused
      // without touching the first's.
      return await runMove(ctx, worktreeId, async (signal) => {
        const invite = inviteMirror({
          peerDeviceId: sourceDeviceId,
          sourceWorktreeId: worktreeId,
          identity,
          cloneInto: rule.cloneInto,
        });
        const offCancel = onAbort(signal, () => {
          void peerSync
            .cancelMove({ sourceWorktreeId: worktreeId })
            .catch(() => {});
        });
        try {
          return decodeMirrorStartToResult(
            await peerMirrorApiFor(sourceDeviceId).startTo({
              targetDeviceId: thisDeviceId(),
              projectId,
              worktreeId,
              ...rule,
            }),
          );
        } catch (error) {
          invite.withdraw();
          throw error;
        } finally {
          offCancel();
        }
      });
    } finally {
      stopRelay();
    }
  },

  // Stop ends the session and removes the copy the mirror made: the
  // mirror was the copy's reason to exist, and the source keeps the
  // branch. The copy is the peer's worktree, and the original here
  // stays. The delete follows the terminate (the other way round the
  // tombstone protocol would stop the session itself, mid-delete) and
  // is forced, since the copy carries the source's uncommitted state
  // by design. A copy the delete cannot remove is reported with the
  // session already gone: the worktree page then offers the ordinary
  // delete.
  //
  // A stop whose original is gone (removed outside the app) ends the
  // session alone: the copy is then the only one there is, and it is
  // never removed, forced or not.
  stop: async ({ session, force }) => {
    const daemon = engine();
    const raw = findSession(daemon, session);
    if (raw === undefined) {
      throw new Error("That mirror is no longer running.");
    }
    if (!(await rootExists(raw.localRoot))) {
      await endMirrorKeepingCopy(daemon, raw, ORIGINAL_GONE_DETAIL);
      return { removedCopy: false };
    }
    // The copy goes with the stop, so it must hold nothing the original
    // lacks: git in step, looked at again now rather than read off the
    // last verdict (a commit on the copy a moment ago is exactly what
    // must not be lost), and the files settled, since git says nothing
    // about an edit the engine has not carried yet or holds still as a
    // conflict.
    if (force !== true) {
      const git = await daemon.refreshGit(session);
      const live = findSession(daemon, session) ?? raw;
      const blocker = mirrorStopBlocker({ ...live, git });
      if (blocker !== undefined) {
        // A copy the peer no longer lists (deleted while this device
        // missed the announcement, or moved) holds nothing to protect
        // and nothing to remove, so the session just ends.
        if (await endMirrorIfCopyGone(raw)) return { removedCopy: true };
        throw new Error(mirrorStopRefusal(blocker));
      }
    }
    stopping.set(session, {
      ...annotateMirrorSession(raw, daemon.gitStatus(session)),
      stopping: true,
    });
    try {
      await stopAndRemoveCopy(daemon, session, raw);
    } finally {
      stopping.delete(session);
      onServingChange?.();
    }
    return { removedCopy: true };
  },
  pause: ({ session }) => pauseOrResume(session, "pause", "paused"),
  resume: ({ session }) => pauseOrResume(session, "resume", "resumed"),

  // The engine cannot re-configure a live session, so a change of
  // ignores re-opens it on the same pair (MirrorImpl.recreate, which
  // keeps the old one until the new one is up and carries the git
  // follower's agreement across), the labels carried over. The pair's
  // files are already in agreement, so the new session's first cycle
  // has little to do.
  //
  // Only on a settled pair: the new session starts with no shared
  // history, so a path only one side holds crosses to the other. On a
  // pair in step that is nothing. On a paused, halted or conflicted
  // one it would bring back what was deleted on one side meanwhile,
  // and a paused session would come back running.
  setIgnores: async ({ session, ignoreMode, ignores }) => {
    const daemon = engine();
    const raw = findSession(daemon, session);
    if (raw === undefined) {
      throw new Error("That mirror is no longer running.");
    }
    if (!mirrorFilesSettled(raw)) {
      throw new Error(
        "What the mirror leaves out can change once it is running and in step. Resume it, or wait for it to catch up.",
      );
    }
    if (reopening.has(session)) {
      throw new Error("What the mirror leaves out is already changing.");
    }
    reopening.add(session);
    try {
      const localWorktreeId = localWorktreeIdOf(raw);
      const next = await daemon.recreate(session, {
        localRoot: raw.localRoot,
        deviceId: raw.deviceId,
        projectId: raw.projectId,
        worktreeId: raw.worktreeId,
        remoteRoot: raw.remoteRoot,
        name: raw.name,
        localWorktreeId,
        labels: {
          ...raw.labels,
          [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
          [MIRROR_LABEL_REPLACES]: session,
        },
        ignores,
      });
      daemon.noteEvent(
        localWorktreeId,
        "ignores-changed",
        summarizeIgnores(ignoreMode, ignores),
      );
      return { session: next };
    } finally {
      reopening.delete(session);
    }
  },

  // The runner ended its mirror into a copy here and kept the copy:
  // the invitation goes, the worktree stays.
  release: ({ worktreeId }) => {
    forgetMirrorInvitesOf(worktreeId);
  },

  history: ({ localWorktreeId }) => ({
    events: engine().history(localWorktreeId),
  }),

  // A mirror stream: the far end is a fresh `file-sync serve` for the
  // named worktree, spoken to over its stdio. The worktree must exist
  // in this host's registry (a peer can only mirror what this device
  // lists), and the child dies with the channel: a peer reset, an end
  // from both sides or the socket dying all kill it, and a child that
  // exits on its own ends the channel the ordinary way. The root path
  // the peer's Mutagen side names travels inside the protocol, which
  // this handler does not read: the grant is the wall, as everywhere
  // on the byte-stream surface.
  openStream: async (
    { projectId, worktreeId, channelId, peerWorktreeId },
    ctx,
  ) => {
    requireChannels(ctx, channelId);
    const worktreePath = await findWorktreePathOrThrow({
      projectId,
      worktreeId,
    });
    // Its own data directory under this host's: unset, the engine's
    // caches and staging land in ~/.mutagen, shared with any real
    // Mutagen install and with every other build and profile here.
    const child = spawnFileSync(["serve"], {
      ...process.env,
      MUTAGEN_DATA_DIRECTORY: join(dataDir(), "file-sync", "serve"),
    });
    if (child === null) {
      throw new Error(
        "mirroring is unavailable on this device (no file-sync engine)",
      );
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text !== "") log.warn(`[mirror] serve ${worktreeId}: ${text}`);
    });
    const key = servingKey(ctx, channelId);
    const stopChild = () => {
      child.kill();
      child.stream.destroy();
    };
    try {
      attachFarEnd(ctx, channelId, child.stream, {
        onClosed: () => {
          stopChild();
          forgetServing(key);
        },
      });
    } catch (error) {
      // The connection died or the id was claimed during the lookup
      // above: the child is detached, so the destroyed stdio alone
      // would not end it.
      stopChild();
      throw error;
    }
    const served: Served = {
      entry: {
        channelId,
        projectId,
        worktreeId,
        peerDeviceId: ctx.callerDeviceId ?? "",
        ...(peerWorktreeId === undefined ? {} : { peerWorktreeId }),
        since: Date.now(),
      },
      stopIndexWatch: null,
    };
    serving.set(key, served);
    void watchIndexFile(worktreePath, () =>
      onServingGitChange?.({ projectId, worktreeId }),
    ).then(
      (stop) => {
        if (serving.get(key) === served) served.stopIndexWatch = stop;
        else stop();
      },
      () => {},
    );
    onServingChange?.();
  },

  // The git half served to the device mirroring from here (see
  // host/mirror/gitState.ts): the worktree must be one this host
  // lists, and the state is read or applied in place.
  gitState: async ({ projectId, worktreeId }) => {
    const { project, worktree: identity } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return readGitState(project.path, identity.path, worktreeId);
  },

  applyGitState: async ({ projectId, worktreeId, expect, state, sweep }) => {
    const { project, worktree: identity } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    const result = await applyGitState(
      project,
      { id: worktreeId, path: identity.path },
      { expect, state, sweep },
    );
    if (!result.applied) return { applied: false, reason: result.reason };
    onGitApplied?.(project.id);
    return { applied: true };
  },
};
