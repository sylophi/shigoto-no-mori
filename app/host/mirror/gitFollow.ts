// The git follower: for every mirror session this device runs, keeps
// the git state of the local worktree and the peer's worktree the same
// (host/mirror/gitState.ts defines that state), so a commit, a stage,
// a checkout or a reset on either machine shows up on the other within
// a moment. The file-sync engine owns the files. This owns HEAD, the
// tip and the staged tree.
//
// Which way git follows is followPlan.ts's to decide, and the
// transfers are followTransfer.ts's.
//
// A side in the middle of a git operation (a rebase, a merge, a
// cherry-pick, a revert, a bisect) refuses to be read or written
// (gitState.ts GIT_OPERATION_IN_PROGRESS), and the session reads
// blocked until it finishes, naming the side. Mirroring the half-way
// state would carry a detached HEAD or a conflicted index to the other
// side, and the finished operation would then collide with it there.
//
// Git follows the files, never leads them. A change that moves the tip
// or the branch waits while the file-sync engine is mid-cycle: landing
// a checkout's HEAD and index before its files would show the other
// side a reverse diff, which a commit there would record as a revert.
// The engine's next idle snapshot sets the follow going again.
//
// Signals: the local git-directory watcher (a project ping), a local
// index watcher per session, the peer's git:projectChanged and
// mirror:gitChanged pushes, every daemon snapshot whose session set
// changed (or that finds a waiting session's files caught up), and a
// slow periodic sweep as the backstop. Reconciles are coalesced per
// session: one in flight, one queued.
import { errorMessageOf, isEntityGoneError } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Context from "effect/Context";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import type * as Engine from "@host/lib/engine";
import {
  isHaltedStatus,
  MIRROR_LABEL_REPLACES,
  type MirrorGitStatus,
} from "@shigomori/contracts/modules/mirror";
import { peerMirrorFor } from "@host/ipc/peerSync";
import { findProject } from "@host/lib/projects";
import { followDescription } from "@host/lib/sync/worktreeDescription";
import {
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  onMirrorBranch,
} from "./registry";
import {
  CHANGED_LOCALLY,
  core,
  type FollowableSession,
  describeDivergence,
  MIRROR_NAMES,
  OFF_MIRROR_BRANCH,
  operationDetail,
  SAME_NAMES,
  sameHead,
  sameState,
} from "./followPlan";
import { chooseDirection, pull, push } from "./followTransfer";
import {
  type GitState,
  type GitStateCore,
  operationInRefusal,
  readGitState,
  watchIndexFile,
} from "./gitState";
import { log } from "@shared/log";

// Where the agreed states live between runs: one entry per session id.
export type AgreedStore = {
  load(): Record<string, GitStateCore>;
  save(entries: Record<string, GitStateCore>): void;
};

type FollowRecord = {
  session: FollowableSession;
  status: MirrorGitStatus;
  agreed: GitStateCore | null;
  // The reconcile loop in flight (it runs the queued follow-up too
  // before settling), or null when idle.
  running: Fiber.Fiber<void> | null;
  pending: boolean;
  // A follow that moves the tip or the branch was held back for the
  // files to settle. The next idle snapshot re-triggers it.
  waitingForFiles: boolean;
  stopIndexWatch: (() => void) | null;
};

// The backstop only: every real change arrives as a signal, so the
// sweep is slow, and each tick costs a local read plus one peer round
// trip per session.
const DEFAULT_SWEEP_MS = 60_000;

// How often a session whose copy reads as gone is reported to
// onCopyGone: every signal fails the same way until the owner acts.
const COPY_GONE_EVERY_MS = 60_000;

// How long reconcileNow waits on a reconcile before answering with the
// status as it stands. A stalled peer can hold a round for as long as
// its transport's timeout, and the caller is a user waiting on a stop.
const RECONCILE_NOW_LIMIT_MS = 10_000;

export type GitFollower = ReturnType<typeof makeFollower>;

// The follower, for the length of the scope: its signals are posted to
// an inbox one fiber works through, so a watcher or a push can signal
// it from anywhere, and every reconcile runs in the scope.
export const makeGitFollower = (deps: {
  sessions: Effect.Effect<readonly FollowableSession[]>;
  // Persists the agreed state per session. Absent means memory only
  // (the checks).
  agreedStore?: AgreedStore;
  // Fires when any session's git status changes.
  onChange?: () => void;
  sweepMs?: number;
  log?: (message: string) => void;
  // The peer answered that the session's copy is not a worktree it
  // lists (deleted, moved, or re-created where its id points elsewhere,
  // none of which announced itself here). A peer that is merely away
  // answers nothing and is no such report. At most once a minute per
  // session.
  onCopyGone?: (session: FollowableSession) => void;
  // Carries the worktree's title and description between the two
  // sides (host/lib/sync/worktreeDescription.ts) on every reconcile
  // that reaches the peer, whatever the git state decides. Off in the
  // checks that don't exercise it.
  followDescription?: boolean;
  // A pull landed here: refs, HEAD and the index moved in the local
  // project by the app's own git, which the git-directory watcher
  // skips as the app's own writes, so nothing else would tell this
  // device's pages (and its viewers) that the worktree moved.
  onLocalApplied?: (localProjectId: string) => void;
}) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<Effect.Effect<void>>();
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<FollowServices>();
    const follower = makeFollower(deps, (work) => {
      Queue.offerUnsafe(inbox, work);
    });
    // The inbox's worker: each signal's work in turn, a reconcile it
    // starts running on its own in the scope.
    yield* Effect.forkScoped(Effect.forever(Effect.flatten(Queue.take(inbox))));
    follower.attach(scope, context);
    yield* Effect.addFinalizer(() => Effect.sync(follower.detach));
    // The backstop sweep.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(
          follower.reconcileAll,
          Effect.sleep(deps.sweepMs ?? DEFAULT_SWEEP_MS),
        ),
      ),
    );
    return follower;
  });

// The failure an exit ended in, if any.
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

// What the reconciles reach: the engine and git.
type FollowServices = Engine.Services | ChildProcessSpawner.ChildProcessSpawner;

const reconcileOf = (
  deps: Parameters<typeof makeGitFollower>[0],
  helpers: {
    setStatus: (record: FollowRecord, status: MirrorGitStatus) => void;
    setAgreed: (record: FollowRecord, agreed: GitStateCore) => void;
    filesSettled: (record: FollowRecord) => Effect.Effect<boolean>;
    copyGone: (session: FollowableSession) => void;
    warn: (message: string) => void;
    descriptionFailed: Set<string>;
  },
) =>
  Effect.fnUntraced(function* (record: FollowRecord) {
    const { setStatus, setAgreed, filesSettled, copyGone, warn } = helpers;
    const { session } = record;
    if (session.paused) {
      record.waitingForFiles = false;
      setStatus(record, { status: "off", detail: "paused" });
      return;
    }
    // Still waiting on the files: the reads would only end at the same
    // wait (filesSettled restates it, a halt included), and the idle
    // snapshot triggers this again (syncSessions).
    if (record.waitingForFiles && !(yield* filesSettled(record))) return;
    record.waitingForFiles = false;
    const localProjectId = session.labels[MIRROR_LABEL_LOCAL_PROJECT] ?? "";
    const localWorktreeId = session.labels[MIRROR_LABEL_LOCAL_WORKTREE] ?? "";
    const found = yield* Effect.result(findProject(localProjectId));
    if (Result.isFailure(found)) {
      setStatus(record, {
        status: "error",
        detail: errorMessageOf(found.failure),
      });
      return;
    }
    const project = found.success;
    const localWorktree = { id: localWorktreeId, path: session.localRoot };
    const names = onMirrorBranch(session) ? MIRROR_NAMES : SAME_NAMES;
    yield* Effect.gen(function* () {
      // Independent reads, so the local git work hides under the peer
      // round trip. The apply's compare-and-set covers either side
      // moving in between. Settled apart, since which side failed is
      // what decides the report.
      const [localRead, peerRead] = yield* Effect.all(
        [
          Effect.exit(
            readGitState(project.path, localWorktree.path, localWorktree.id),
          ),
          Effect.exit(
            peerMirrorFor(session.deviceId).gitState({
              projectId: session.projectId,
              worktreeId: session.worktreeId,
            }),
          ),
        ],
        { concurrency: 2 },
      );
      // Only once the peer has answered, so an unreachable one is not
      // a failure logged on every sweep.
      if (Exit.isSuccess(peerRead) && deps.followDescription === true) {
        yield* Effect.forkDetach(
          followDescription(
            session.deviceId,
            { projectId: localProjectId, worktreeId: localWorktreeId },
            { projectId: session.projectId, worktreeId: session.worktreeId },
          ).pipe(
            Effect.tap((wrote) =>
              Effect.sync(() => {
                helpers.descriptionFailed.delete(session.session);
                if (wrote === "here") deps.onLocalApplied?.(localProjectId);
              }),
            ),
            Effect.catch((error) =>
              Effect.sync(() => {
                if (helpers.descriptionFailed.has(session.session)) return;
                helpers.descriptionFailed.add(session.session);
                warn(
                  `[mirror] following the title and description failed: ${errorMessageOf(error)}`,
                );
              }),
            ),
          ),
        );
      }
      const peerFailure = failureOf(peerRead);
      const peerOperation =
        peerFailure === undefined
          ? null
          : operationInRefusal(errorMessageOf(peerFailure));
      if (peerFailure !== undefined && isEntityGoneError(peerFailure)) {
        copyGone(session);
      }
      if (Exit.isFailure(localRead)) {
        const failure = Cause.squash(localRead.cause);
        const operation = operationInRefusal(errorMessageOf(failure));
        if (operation === null) return yield* Effect.fail(failure);
        setStatus(record, {
          status: "blocked",
          detail: operationDetail(operation, "here"),
        });
        return;
      }
      if (Exit.isFailure(peerRead)) {
        if (peerOperation === null) return yield* Effect.fail(peerFailure);
        setStatus(record, {
          status: "blocked",
          detail: operationDetail(peerOperation, "there"),
        });
        return;
      }
      const local = localRead.value;
      const peerAsIs = peerRead.value;
      // Each side's head in the other's names: the peer's is what
      // agreement, divergence and the apply are judged on, this side's
      // is what a push carries. A copy that left the mirror/ rule has
      // no name on the other side, and is reported, not followed.
      const peerHead = names.toLocal(peerAsIs.head);
      const headThere = names.toPeer(local.head);
      if (peerHead === null || headThere === null) {
        setStatus(record, { status: "blocked", detail: OFF_MIRROR_BRANCH });
        return;
      }
      const peer: GitState = { ...peerAsIs, head: peerHead };
      if (sameState(local, peer)) {
        setAgreed(record, core(peer));
        setStatus(record, { status: "synced", detail: "" });
        return;
      }

      const direction = yield* chooseDirection(
        project.path,
        record.agreed,
        local,
        peer,
      );
      if (direction === "diverged") {
        setStatus(record, {
          status: "diverged",
          detail: describeDivergence(local, peer),
        });
        return;
      }
      // Moving the tip or the branch rewrites what `git status` compares
      // the files against, so it waits for the files to land first. An
      // index-only change does not: the engine already carried whatever
      // was staged.
      const movesTip =
        local.tip !== peer.tip || !sameHead(local.head, peer.head);
      if (movesTip && !(yield* filesSettled(record))) return;
      setStatus(record, {
        status: "following",
        detail:
          direction === "pull"
            ? "from the other device"
            : "to the other device",
      });

      const round = { project, localWorktree, session, local, peer };
      const outcome =
        direction === "pull"
          ? yield* pull(round, peerAsIs.head, record.agreed?.tip ?? null)
          : yield* push(round, headThere);
      if (outcome.applied) {
        setAgreed(record, direction === "pull" ? core(peer) : core(local));
        setStatus(record, { status: "synced", detail: "" });
        if (direction === "pull") deps.onLocalApplied?.(localProjectId);
        return;
      }
      if (outcome.reason === CHANGED_LOCALLY) {
        // The side being written moved between our read and the
        // apply. Look again right away.
        record.pending = true;
        return;
      }
      setStatus(record, { status: "blocked", detail: outcome.reason });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const message = errorMessageOf(Cause.squash(cause));
          warn(`[mirror] git follow ${session.session}: ${message}`);
          setStatus(record, { status: "error", detail: message });
        }),
      ),
    );
  });

function makeFollower(
  deps: Parameters<typeof makeGitFollower>[0],
  post: (work: Effect.Effect<void>) => void,
) {
  const records = new Map<string, FollowRecord>();
  const copyGoneAt = new Map<string, number>();
  // Sessions whose title carry has failed, so a peer that can't take it
  // (an older build) is reported once, not on every sweep.
  const descriptionFailed = new Set<string>();
  const warn = deps.log ?? ((message: string) => log.warn(message));
  // The scope the reconciles run in, and what they reach, once the
  // follower is up.
  let runIn: {
    scope: Scope.Scope;
    context: Context.Context<FollowServices>;
  } | null = null;
  // The agreed states by session id, loaded on the first look and
  // written back only when an entry actually changes.
  let stored: Record<string, GitStateCore> = {};
  let loaded = false;

  function loadStored(): void {
    if (loaded) return;
    loaded = true;
    try {
      stored = deps.agreedStore?.load() ?? {};
    } catch (error) {
      warn(
        `[mirror] git follow: agreed store unreadable: ${errorMessageOf(error)}`,
      );
    }
  }

  function setStatus(record: FollowRecord, status: MirrorGitStatus): void {
    if (
      record.status.status === status.status &&
      record.status.detail === status.detail
    ) {
      return;
    }
    record.status = status;
    deps.onChange?.();
  }

  function persist(): void {
    try {
      deps.agreedStore?.save(stored);
    } catch (error) {
      warn(
        `[mirror] git follow: agreed store unwritable: ${errorMessageOf(error)}`,
      );
    }
  }

  function setAgreed(record: FollowRecord, agreed: GitStateCore): void {
    if (record.agreed !== null && sameState(record.agreed, agreed)) return;
    record.agreed = agreed;
    stored[record.session.session] = agreed;
    persist();
  }

  function copyGone(session: FollowableSession): void {
    if (deps.onCopyGone === undefined) return;
    const now = Date.now();
    const last = copyGoneAt.get(session.session);
    if (last !== undefined && now - last < COPY_GONE_EVERY_MS) return;
    copyGoneAt.set(session.session, now);
    try {
      deps.onCopyGone(session);
    } catch (error) {
      warn(
        `[mirror] git follow ${session.session}: ending a gone copy failed: ${errorMessageOf(error)}`,
      );
    }
  }

  // Whether the files are idle enough for a follow that moves the tip
  // or the branch. If not, the record waits for the snapshot that says
  // they are (syncSessions). The engine's status is read fresh, since
  // the record's copy is only as new as the last session-set change.
  // A halted session will not catch up by itself, so it reads blocked
  // rather than following forever. A paused one never gets here.
  const filesSettled = (record: FollowRecord) =>
    Effect.map(deps.sessions, (sessions) => {
      const id = record.session.session;
      const status =
        sessions.find((s) => s.session === id)?.status ?? record.session.status;
      if (status === "watching") return true;
      record.waitingForFiles = true;
      setStatus(
        record,
        isHaltedStatus(status)
          ? {
              status: "blocked",
              detail: "file sync has halted. Git follows again once it runs",
            }
          : { status: "following", detail: "waiting for files to catch up" },
      );
      return false;
    });

  const reconcile = reconcileOf(deps, {
    setStatus,
    setAgreed,
    filesSettled,
    copyGone,
    warn,
    descriptionFailed,
  });

  // Starts a reconcile, or queues one behind the reconcile in flight.
  const trigger = (record: FollowRecord): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (record.running !== null) {
        record.pending = true;
        return Effect.void;
      }
      if (runIn === null) return Effect.void;
      const loop = Effect.gen(function* () {
        do {
          record.pending = false;
          yield* reconcile(record);
        } while (
          record.pending &&
          records.get(record.session.session) === record
        );
      }).pipe(
        Effect.provide(runIn.context),
        Effect.ensuring(
          Effect.sync(() => {
            record.running = null;
          }),
        ),
      );
      return Effect.map(Effect.forkIn(loop, runIn.scope), (fiber) => {
        record.running = fiber as Fiber.Fiber<void>;
      });
    });

  const triggerWhere = (matches: (session: FollowableSession) => boolean) =>
    Effect.forEach(
      [...records.values()].filter((record) => matches(record.session)),
      trigger,
      { discard: true },
    );

  // Bring the followed set in line with the daemon's sessions: a new
  // session gets a record (seeded from the stored agreement) and an
  // index watcher, a gone one is dropped. Its stored agreement stays:
  // the daemon reports no sessions while it restarts, and the same
  // sessions come back a moment later. Only forget() below, on an
  // explicit terminate, drops the agreement. True when a session
  // came, went or flipped its pause. A session that replaced another (a
  // re-open, MIRROR_LABEL_REPLACES) and has no agreement of its own
  // starts from the replaced one's. A record waiting for its files is
  // triggered here the moment the engine reports them idle.
  const syncSessions = Effect.gen(function* () {
    loadStored();
    const current = new Map((yield* deps.sessions).map((s) => [s.session, s]));
    let changed = false;
    for (const [id, record] of records) {
      if (!current.has(id)) {
        record.stopIndexWatch?.();
        records.delete(id);
        copyGoneAt.delete(id);
        changed = true;
      }
    }
    for (const [id, session] of current) {
      const existing = records.get(id);
      if (existing !== undefined) {
        if (existing.session.paused !== session.paused) changed = true;
        existing.session = session;
        if (existing.waitingForFiles && session.status === "watching") {
          existing.waitingForFiles = false;
          yield* trigger(existing);
        }
        continue;
      }
      changed = true;
      const record: FollowRecord = {
        session,
        status: { status: "off", detail: "" },
        agreed: stored[id] ?? inheritAgreement(id, session),
        running: null,
        pending: false,
        waitingForFiles: false,
        stopIndexWatch: null,
      };
      records.set(id, record);
      if (runIn !== null) {
        yield* Effect.forkIn(
          watchIndexFile(session.localRoot, () => post(trigger(record))).pipe(
            Effect.tap((stop) =>
              Effect.sync(() => {
                if (records.get(id) === record) record.stopIndexWatch = stop;
                else stop();
              }),
            ),
            Effect.ignore,
            Effect.provide(runIn.context),
          ),
          runIn.scope,
        );
      }
    }
    if (changed) deps.onChange?.();
    return changed;
  });

  function inheritAgreement(
    id: string,
    session: FollowableSession,
  ): GitStateCore | null {
    const replaced = session.labels[MIRROR_LABEL_REPLACES];
    const inherited = replaced === undefined ? undefined : stored[replaced];
    if (inherited === undefined) return null;
    stored[id] = inherited;
    persist();
    return inherited;
  }

  const reconcileAll = Effect.andThen(
    syncSessions,
    Effect.suspend(() =>
      Effect.forEach(records.values(), trigger, { discard: true }),
    ),
  );

  return {
    attach(scope: Scope.Scope, context: Context.Context<FollowServices>): void {
      runIn = { scope, context };
    },
    detach(): void {
      runIn = null;
      for (const record of records.values()) record.stopIndexWatch?.();
      records.clear();
    },
    reconcileAll,
    // The daemon reported a snapshot: only a session coming, going or
    // flipping its pause is worth a re-look.
    sessionsChanged(): void {
      post(
        Effect.flatMap(syncSessions, (changed) =>
          changed
            ? Effect.forEach(records.values(), trigger, { discard: true })
            : Effect.void,
        ),
      );
    },
    // The session was terminated on purpose: its agreement goes too.
    forget(session: string): void {
      loadStored();
      if (session in stored) {
        delete stored[session];
        persist();
      }
    },
    // The session was re-opened under a new id on the same pair (an
    // ignore change): the agreement follows it, on disk and on the
    // live record if the daemon's snapshot already made one. An
    // agreement the new id already holds (inherited through its
    // replaces label, or reached since) is newer and stays.
    rename(from: string, to: string): void {
      loadStored();
      const agreed = stored[from];
      if (agreed === undefined) return;
      delete stored[from];
      stored[to] ??= agreed;
      persist();
      const record = records.get(to);
      if (record !== undefined && record.agreed === null)
        record.agreed = stored[to];
    },
    // A reconcile of one session right away, for a caller about to act
    // on its verdict (a stop's safety check): queued behind one in
    // flight, and answered once both have run. Bounded, so a stalled
    // peer answers with the status as it stands. Undefined when the
    // session is not followed.
    reconcileNow: (session: string) =>
      Effect.gen(function* () {
        yield* syncSessions;
        const record = records.get(session);
        if (record === undefined) return undefined;
        yield* trigger(record);
        const running = record.running;
        if (running !== null) {
          yield* Fiber.await(running).pipe(
            Effect.timeoutOrElse({
              duration: RECONCILE_NOW_LIMIT_MS,
              orElse: () => Effect.void,
            }),
          );
        }
        return records.get(session)?.status;
      }).pipe(Effect.orElseSucceed(() => undefined)),
    onLocalProjectChanged(projectId: string): void {
      post(
        Effect.andThen(
          syncSessions,
          triggerWhere(
            (s) => s.labels[MIRROR_LABEL_LOCAL_PROJECT] === projectId,
          ),
        ),
      );
    },
    onPeerProjectChanged(deviceId: string, projectId: string): void {
      post(
        triggerWhere(
          (s) => s.deviceId === deviceId && s.projectId === projectId,
        ),
      );
    },
    onPeerWorktreeChanged(
      deviceId: string,
      projectId: string,
      worktreeId: string,
    ): void {
      post(
        triggerWhere(
          (s) =>
            s.deviceId === deviceId &&
            s.projectId === projectId &&
            s.worktreeId === worktreeId,
        ),
      );
    },
    statusOf(session: string): MirrorGitStatus | undefined {
      return records.get(session)?.status;
    },
  };
}
