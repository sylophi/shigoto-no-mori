// The host's interactive shells. Each terminal is a login shell under a
// PTY (../scripts/ScriptRuns.ts), a resource in a scope of its own under the
// layer's: closing it is closing that scope, whose release is the kill
// chain. A terminal belongs to a worktree, which it starts in with the
// environment the worktree's scripts get and closes with, or to the
// device, where it starts in the folder the last one was in. Its
// history and folder are saved (SavedTerminals) a moment after its
// output changes and again as it closes, so after a quit or a crash the
// next start opens a fresh shell there under that history.
//
// Its output goes out in chunks, numbered by `seq`, to every client
// attached, through a bounded PubSub: a client that stops taking holds
// the shell's output back rather than pile it up here, and the PTY is
// paused while the backlog is large. History is a ring of the latest
// chunks (./history.ts), which an attach replays first.
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import {
  UnknownProjectError,
  UnknownTerminalError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import type {
  Terminal,
  TerminalEvent,
  TerminalOwner,
} from "@shigomori/contracts/schemas";
import * as SavedTerminals from "@shigomori/engine/SavedTerminals";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { log } from "@shared/log";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processes from "@shigomori/engine/processes";
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import { type PtyHandle, PtySpawnError, spawn } from "../scripts/ScriptRuns";
import { type History, makeHistory } from "./history";

type Size = { readonly cols: number; readonly rows: number };

// Where a terminal's shell starts and what it is given.
export type Start = {
  // The worktree's folder. A device's terminal has none of its own.
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const DEFAULT_SIZE: Size = { cols: 120, rows: 40 };

// `data` in chunks of at most CHUNK_MAX, never between the two halves
// of a surrogate pair.
function pieces(data: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(data.length, at + CHUNK_MAX);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(data.slice(at, end));
    at = end;
  }
  return out;
}
// Reads within a frame go out as one chunk (as a script's output does).
const BATCH = Duration.millis(16);
// Chunks a client may fall behind by before the shell's output waits
// for it.
const CLIENT_BACKLOG = 64;
// The most one chunk holds, in UTF-16 code units: at most 768 KiB as
// UTF-8, so a chunk fits a message of the stream it goes out on
// (host/socket/boundedMessages.ts). A batch past it goes as several.
const CHUNK_MAX = 256 * 1024;
// Output read from the PTY and not yet sent, past which the PTY is
// paused, and below which it reads again.
const PAUSE_AT = 1024 * 1024;
const RESUME_AT = 256 * 1024;
// A terminal's changed history is saved once its output has been quiet
// this long, and at least this often while it keeps changing (a flood,
// an agent CLI's spinner): what a crash may lose, against one write of
// the whole ring each time.
const SAVE_QUIET = Duration.seconds(2);
const SAVE_AT_MOST = Duration.minutes(1);
// A shell is stopped with SIGHUP, as when its window closes, and
// SIGKILL a moment later if it is still there.
const STOPPING = { graceMs: 1_000, wait: true, signal: "SIGHUP" } as const;
// What a restored history ends with, so the fresh shell's prompt lands
// on a clean screen: out of the mouse and the keypad modes, with the
// cursor shown and the colors reset.
const RESTORED_TAIL =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b>\x1b[?25h\x1b[0m\r\n";
// A private mode set or reset (CSI in seven or eight bits), its modes as
// they come (`1049;25`), or a full reset, which leaves the alternate
// screen too.
// A control character inside one is carried out and skipped, as a
// terminal does, but CAN and SUB end it.
const SCREEN_MODES = new RegExp(
  String.raw`(?:\x1b\[|\x9b)\?([\d;\x00-\x17\x19\x1c-\x1f]+)([hl])|\x1bc`,
  "g",
);
// The start of a sequence the output so far hasn't finished.
const UNFINISHED = new RegExp(
  String.raw`(?:\x1b\[|\x9b)[\x00-\x17\x19\x1c-\x3f]*$|\x1b$`,
);
const ALTERNATE = new Set([1049, 1047, 47]);

// Whether `text` leaves the terminal on the alternate screen, from
// `before` at its start, and where it last went there if it did.
export const alternateScreen = (
  text: string,
  before = false,
): { readonly on: boolean; readonly enteredAt: number | undefined } => {
  let on = before;
  let enteredAt: number | undefined;
  for (const match of text.matchAll(SCREEN_MODES)) {
    const [sequence, modes, set] = match;
    if (sequence === "\x1bc") {
      on = false;
      enteredAt = undefined;
      continue;
    }
    const listed = modes?.replace(/[^\d;]/g, "").split(";") ?? [];
    if (!listed.some((mode) => ALTERNATE.has(Number(mode)))) {
      continue;
    }
    if (set === "l") {
      on = false;
      enteredAt = undefined;
    } else if (!on) {
      on = true;
      enteredAt = match.index;
    }
  }
  return { on, enteredAt };
};

// The alternate screen after a read, from where the last one left it,
// with what of this one the next has to finish.
export const followAlternate = (
  before: { readonly on: boolean; readonly carry: string },
  data: string,
): { readonly on: boolean; readonly carry: string } => {
  const seen = before.carry + data;
  return {
    on: alternateScreen(seen, before.on).on,
    carry: (UNFINISHED.exec(seen)?.[0] ?? "").slice(-256),
  };
};

// What a terminal's next start replays: a history that ends on the
// alternate screen (a full-screen program ran at the quit) up to where
// it went there, the main screen as that program found it, cursor and
// all, or none of it if the ring no longer holds that point. Leaving the
// alternate screen instead puts the cursor where the program left it,
// or for 1049 where it saved it, and the fresh prompt's clear to the
// end of the screen would wipe the lines above.
export const replayable = (history: string, alternate: boolean): string => {
  if (!alternate) return history;
  return history.slice(0, alternateScreen(history).enteredAt ?? 0);
};

interface Session {
  readonly terminal: Terminal;
  readonly pty: PtyHandle;
  readonly history: History;
  readonly events: PubSub.PubSub<TerminalEvent>;
  readonly scope: Scope.Closeable;
  // Opened by output the store doesn't have yet, the last at
  // `changedAt`.
  readonly changed: Latch.Latch;
  changedAt: number;
  seq: number;
  size: Size;
  exited: Option.Option<number | null>;
  // On the alternate screen, followed as output comes in, so it holds
  // once the ring has dropped where the program went there.
  alternate: boolean;
  // A sequence the last read left unfinished, which the next finishes.
  carry: string;
  // Closed by its user or with its worktree, so not saved for the next
  // start.
  forget: boolean;
}

const ownedBy = (session: Session) =>
  session.terminal.owner.kind === "worktree"
    ? session.terminal.owner
    : undefined;

export class Terminals extends Context.Service<
  Terminals,
  {
    // Every open terminal, oldest first, and again on each open and
    // close.
    readonly list: Stream.Stream<ReadonlyArray<Terminal>>;
    readonly open: (input: {
      readonly owner: TerminalOwner;
      readonly size?: Size | undefined;
    }) => Effect.Effect<
      Terminal,
      PtySpawnError | UnknownProjectError | UnknownWorktreeError
    >;
    readonly close: (
      terminalId: string,
    ) => Effect.Effect<void, UnknownTerminalError>;
    // The history after `after` (all of it when that is gone), the
    // size, then the output and the size as they change, then the
    // exit.
    readonly attach: (
      terminalId: string,
      after?: number,
    ) => Stream.Stream<TerminalEvent, UnknownTerminalError>;
    readonly write: (
      terminalId: string,
      data: string,
    ) => Effect.Effect<void, UnknownTerminalError>;
    // The size every attached client draws at.
    readonly resize: (
      terminalId: string,
      size: Size,
    ) => Effect.Effect<void, UnknownTerminalError>;
    // How many open terminals are the worktree's, or in its folder.
    readonly openIn: (worktree: {
      readonly id: string;
      readonly path: string;
    }) => number;
    // Closes the terminals whose worktree, or its project, is gone. A
    // project whose worktrees can't be read keeps its terminals.
    readonly closeMissing: Effect.Effect<void>;
    // Closes every terminal, none saved for the next start (a nuke).
    readonly closeEvery: Effect.Effect<void>;
    // How many terminals run something in the foreground: what a quit
    // asks about.
    readonly busy: Effect.Effect<number>;
  }
>()("sm/host/Terminals") {}

const make = <R, E>(options: {
  // The folder and environment a terminal starts with: a worktree's
  // scripts', or the app's own for the device's.
  readonly start: (
    owner: TerminalOwner,
  ) => Effect.Effect<Start, UnknownProjectError | UnknownWorktreeError, R>;
  // The worktrees a project has now, where their terminals may stay.
  readonly worktrees: (
    projectId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly path: string }>,
    UnknownProjectError | E,
    R
  >;
}) =>
  Effect.gen(function* () {
    // What the start reads, as the layer finds it.
    const startContext = yield* Effect.context<R>();
    const startOf = (owner: TerminalOwner) =>
      options.start(owner).pipe(Effect.provide(startContext));
    // The folder of each of the project's worktrees, none for a project
    // that is gone, or null when that can't be told: git lists at least
    // the primary checkout of a project it can read, so an empty
    // listing is a read that went missing too.
    const presentIn = (projectId: string) =>
      options.worktrees(projectId).pipe(
        Effect.map((worktrees) =>
          worktrees.length === 0
            ? null
            : new Map(worktrees.map((w) => [w.id, w.path])),
        ),
        Effect.catchTag("UnknownProjectError", () =>
          Effect.succeed(new Map<string, string>()),
        ),
        Effect.catchCause(() => Effect.succeed(null)),
        Effect.provide(startContext),
      );
    const layerScope = yield* Effect.scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const lifecycle = yield* Lifecycle.Lifecycle;
    const saved = yield* SavedTerminals.SavedTerminals;
    const home = yield* Config.String("HOME").pipe(
      Effect.orElseSucceed(() => "/"),
    );
    const sessions = new Map<string, Session>();
    const listed = yield* SubscriptionRef.make<ReadonlyArray<Terminal>>([]);
    const announce = Effect.suspend(() =>
      SubscriptionRef.set(
        listed,
        [...sessions.values()].map((session) => session.terminal),
      ),
    );

    const find = (terminalId: string) => {
      const session = sessions.get(terminalId);
      return session === undefined || Option.isSome(session.exited)
        ? Effect.fail(new UnknownTerminalError({ terminalId }))
        : Effect.succeed(session);
    };

    // The folder a shell is in now, read off the process.
    const folderOf = (session: Session) =>
      Processes.exec("lsof", [
        "-a",
        "-p",
        String(session.pty.pid),
        "-d",
        "cwd",
        "-Fn",
      ]).pipe(
        Effect.map(({ stdout }) =>
          Option.fromNullishOr(
            stdout
              .split("\n")
              .find((line) => line.startsWith("n"))
              ?.slice(1),
          ),
        ),
        Effect.timeout(Duration.seconds(2)),
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    const exists = (path: string) =>
      fs.exists(path).pipe(Effect.orElseSucceed(() => false));

    // The device's next terminal starts where its newest open one is,
    // else where the last one was, else home.
    const deviceFolder = Effect.gen(function* () {
      const newest = [...sessions.values()].findLast(
        (session) => session.terminal.owner.kind === "device",
      );
      const candidates = [
        newest === undefined ? Option.none() : yield* folderOf(newest),
        yield* saved.lastFolder,
      ];
      for (const candidate of candidates) {
        if (Option.isSome(candidate) && (yield* exists(candidate.value))) {
          return candidate.value;
        }
      }
      return home;
    });

    // Takes the PTY's reads in frames, keeps them, and sends each frame
    // as a chunk, then the exit once the shell is gone.
    const pump = (
      session: Session,
      reads: Queue.Queue<string | { readonly exit: number | null }>,
      backlog: { bytes: number; paused: boolean },
    ) =>
      Effect.gen(function* () {
        while (true) {
          const first = yield* Queue.take(reads);
          if (typeof first === "string") yield* Effect.sleep(BATCH);
          const taken = [first, ...(yield* Queue.clear(reads))];
          let data = "";
          let exit: Option.Option<number | null> = Option.none();
          for (const item of taken) {
            if (typeof item === "string") data += item;
            else exit = Option.some(item.exit);
          }
          backlog.bytes -= data.length;
          if (backlog.paused && backlog.bytes < RESUME_AT) {
            backlog.paused = false;
            session.pty.resume();
          }
          ({ on: session.alternate, carry: session.carry } = followAlternate(
            { on: session.alternate, carry: session.carry },
            data,
          ));
          for (const piece of pieces(data)) {
            session.seq += 1;
            session.history.append(session.seq, piece);
            session.changedAt = yield* Clock.currentTimeMillis;
            session.changed.openUnsafe();
            yield* PubSub.publish(session.events, {
              kind: "output",
              data: piece,
              seq: session.seq,
            });
          }
          if (Option.isSome(exit)) {
            session.exited = exit;
            session.forget = true;
            yield* PubSub.publish(session.events, {
              kind: "exit",
              code: exit.value,
            });
            // Its scope closes from outside it, since this fiber is in it.
            yield* Effect.forkIn(end(session), layerScope);
            return;
          }
        }
      });

    // Gone from the list, its clients told, and its scope closed: saved
    // first unless forgotten, then the kill chain.
    const end = (session: Session) =>
      Effect.gen(function* () {
        if (sessions.get(session.terminal.terminalId) !== session) return;
        sessions.delete(session.terminal.terminalId);
        yield* announce;
        if (Option.isNone(session.exited)) {
          session.exited = Option.some(null);
          // A client too far behind to take it is cut off as the scope
          // shuts the PubSub down.
          yield* PubSub.publish(session.events, {
            kind: "exit",
            code: null,
          }).pipe(Effect.timeout(Duration.seconds(1)), Effect.ignore);
        }
        yield* Scope.close(session.scope, Exit.void);
      });

    // The folder a shell is in now, kept as the device's last when it is
    // the device's.
    const noteFolder = Effect.fnUntraced(function* (session: Session) {
      const folder = yield* folderOf(session);
      if (session.terminal.owner.kind === "device" && Option.isSome(folder)) {
        yield* saved.setLastFolder(folder.value);
      }
      return folder;
    });

    // The terminal as it is now, in the store: its folder and its
    // history. One row, written at once, so a crash leaves the last one
    // whole.
    const persist = Effect.fnUntraced(function* (session: Session) {
      const folder = yield* noteFolder(session);
      yield* saved.save({
        ...session.terminal,
        cwd: Option.getOrElse(folder, () => session.terminal.cwd),
        seq: session.seq,
        history: replayable(session.history.text(), session.alternate),
      });
    });

    // Saves the terminal once its output settles, or a minute after it
    // started changing, all that came in meanwhile in one write. A save
    // the store refuses is left to the next.
    const keepSaved = (session: Session) =>
      Effect.forever(
        Effect.gen(function* () {
          yield* session.changed.await;
          const deadline = session.changedAt + Duration.toMillis(SAVE_AT_MOST);
          while (true) {
            const due = Math.min(
              session.changedAt + Duration.toMillis(SAVE_QUIET),
              deadline,
            );
            const now = yield* Clock.currentTimeMillis;
            if (now >= due) break;
            yield* Effect.sleep(due - now);
          }
          session.changed.closeUnsafe();
          // Gone with its shell, so its row goes as it closes.
          if (session.forget) return;
          yield* persist(session).pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("[terminals] a terminal was not saved", defect),
            ),
          );
        }),
      );

    const begin = Effect.fnUntraced(function* (
      terminal: Terminal,
      env: Start["env"],
      size: Size,
      restored?: { readonly seq: number; readonly history: string },
    ) {
      const scope = yield* Scope.fork(layerScope);
      return yield* Effect.gen(function* () {
        const pty = yield* spawn(
          {
            command: null,
            cwd: terminal.cwd,
            place: terminal.owner.kind === "worktree" ? "worktree" : "folder",
            env,
            ...size,
          },
          () => STOPPING,
        ).pipe(
          Scope.provide(scope),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Lifecycle.Lifecycle, lifecycle),
        );
        // A restored history is a chunk of its own, numbered past any
        // chunk the terminal sent before the restart (more may have gone
        // out after its last save), so a client that saw it then starts
        // over. Chunks count far slower than milliseconds.
        const first =
          restored === undefined
            ? 0
            : Math.max(restored.seq + 1, yield* Clock.currentTimeMillis);
        const session: Session = {
          terminal,
          pty,
          history: makeHistory(
            first,
            // A row an earlier build saved holds the history as it was.
            restored === undefined
              ? ""
              : replayable(
                  restored.history,
                  alternateScreen(restored.history).on,
                ) + RESTORED_TAIL,
          ),
          events: yield* PubSub.bounded<TerminalEvent>(CLIENT_BACKLOG),
          scope,
          changed: Latch.makeUnsafe(false),
          changedAt: 0,
          seq: first,
          size,
          exited: Option.none(),
          alternate: false,
          carry: "",
          forget: false,
        };
        yield* Scope.addFinalizer(scope, PubSub.shutdown(session.events));
        const reads = yield* Queue.unbounded<
          string | { readonly exit: number | null }
        >();
        const backlog = { bytes: 0, paused: false };
        pty.onData((data) => {
          backlog.bytes += data.length;
          Queue.offerUnsafe(reads, data);
          if (!backlog.paused && backlog.bytes > PAUSE_AT) {
            backlog.paused = true;
            pty.pause();
          }
        });
        // Heard so node-pty doesn't rethrow a read error on the PTY,
        // which took the whole host down: the exit follows it.
        pty.onError((error) => {
          log.warn(`[terminals] a terminal's PTY failed: ${error.message}`);
        });
        // A shell that dies of a signal has no code to tell.
        pty.onExit(({ exitCode, signal }) => {
          Queue.offerUnsafe(reads, {
            exit: signal !== undefined && signal !== 0 ? null : exitCode,
          });
        });
        yield* Effect.forkIn(pump(session, reads, backlog), scope);
        // Runs as the scope closes, while the shell is still there to be
        // asked where it is, after the saver (forked below) has stopped.
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            if (!session.forget) return yield* persist(session);
            yield* noteFolder(session);
            yield* saved.forget(terminal.terminalId);
          }),
        );
        yield* Effect.forkIn(keepSaved(session), scope);
        sessions.set(terminal.terminalId, session);
        yield* announce;
        return session;
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });

    const mintId = Effect.gen(function* () {
      const parts = yield* Effect.all([
        Random.nextIntBetween(0, 0xffffffff),
        Random.nextIntBetween(0, 0xffffffff),
      ]);
      return parts.map((part) => part.toString(16).padStart(8, "0")).join("");
    });

    const open = Effect.fn("Terminals.open")(function* (input: {
      readonly owner: TerminalOwner;
      readonly size?: Size | undefined;
    }) {
      const start = yield* startOf(input.owner);
      const terminal: Terminal = {
        terminalId: yield* mintId,
        owner: input.owner,
        cwd: start.cwd ?? (yield* deviceFolder),
        openedAt: yield* Clock.currentTimeMillis,
      };
      yield* Effect.annotateCurrentSpan({ terminalId: terminal.terminalId });
      const session = yield* begin(
        terminal,
        start.env,
        input.size ?? DEFAULT_SIZE,
      );
      return session.terminal;
    });

    const closeAll = (matches: (session: Session) => boolean) =>
      Effect.forEach(
        [...sessions.values()].filter(matches),
        (session) => {
          session.forget = true;
          return end(session);
        },
        { concurrency: "unbounded", discard: true },
      );

    // What the last run left, each in a fresh shell where it was, its
    // row kept until the shell saves over it. One whose worktree is gone
    // is dropped.
    const restore = Effect.gen(function* () {
      for (const terminal of yield* saved.list) {
        const start = yield* Effect.option(startOf(terminal.owner));
        if (Option.isNone(start)) {
          yield* saved.forget(terminal.terminalId);
          continue;
        }
        const cwd = (yield* exists(terminal.cwd))
          ? terminal.cwd
          : (start.value.cwd ?? home);
        yield* begin({ ...terminal, cwd }, start.value.env, DEFAULT_SIZE, {
          seq: terminal.seq,
          history: terminal.history,
        }).pipe(
          Effect.onError(() => saved.forget(terminal.terminalId)),
          Effect.catchTags({
            PtySpawnError: (error) =>
              Effect.logWarning(
                "[terminals] a saved terminal did not start",
                error,
              ),
          }),
        );
      }
    });
    yield* restore.pipe(
      Effect.withSpan("Terminals.restore"),
      Effect.forkIn(layerScope),
    );

    return Terminals.of({
      list: SubscriptionRef.changes(listed),
      open,
      close: Effect.fn("Terminals.close")(function* (terminalId: string) {
        const session = yield* find(terminalId);
        session.forget = true;
        yield* end(session);
      }),
      attach: (terminalId, after) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const session = yield* find(terminalId);
            const live = yield* PubSub.subscribe(session.events);
            // A chunk sent between the subscription and this read is in
            // both, and the seq tells which.
            const past = session.history.since(after);
            const head: TerminalEvent[] = [
              { kind: "history", ...past },
              { kind: "size", ...session.size },
            ];
            if (Option.isSome(session.exited)) {
              return Stream.fromIterable([
                ...head,
                { kind: "exit", code: session.exited.value },
              ] satisfies TerminalEvent[]);
            }
            return Stream.fromIterable(head).pipe(
              Stream.concat(
                Stream.fromSubscription(live).pipe(
                  Stream.filter(
                    (event) => event.kind !== "output" || event.seq > past.seq,
                  ),
                  Stream.takeUntil((event) => event.kind === "exit"),
                ),
              ),
            );
          }),
        ),
      write: Effect.fn("Terminals.write")(function* (
        terminalId: string,
        data: string,
      ) {
        const session = yield* find(terminalId);
        // A PTY on its way out refuses the write, which is not worth
        // telling: its exit follows.
        yield* Effect.sync(() => session.pty.write(data)).pipe(Effect.ignore);
      }),
      resize: Effect.fn("Terminals.resize")(function* (
        terminalId: string,
        size: Size,
      ) {
        const session = yield* find(terminalId);
        if (
          size.cols === session.size.cols &&
          size.rows === session.size.rows
        ) {
          return;
        }
        session.size = size;
        yield* Effect.sync(() => session.pty.resize(size.cols, size.rows)).pipe(
          Effect.ignore,
        );
        yield* PubSub.publish(session.events, { kind: "size", ...size });
      }),
      // A shell is busy while its terminal's foreground process group
      // is not its own: a job it started holds the terminal.
      busy: Effect.gen(function* () {
        const pids = [...sessions.values()].map((session) => session.pty.pid);
        if (pids.length === 0) return 0;
        const { stdout } = yield* Processes.exec("ps", [
          "-o",
          "pid=,tpgid=",
          "-p",
          pids.join(","),
        ]).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
          Effect.orElseSucceed(() => ({ stdout: "" })),
        );
        return stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number))
          .filter(([pid, tpgid = 0]) => tpgid > 0 && tpgid !== pid).length;
      }).pipe(Effect.withSpan("Terminals.busy")),
      openIn: (worktree) =>
        [...sessions.values()].filter(({ terminal: { owner, cwd } }) =>
          owner.kind === "worktree"
            ? owner.worktreeId === worktree.id
            : isSameOrInside(cwd, worktree.path),
        ).length,
      closeMissing: Effect.gen(function* () {
        const owned = [...sessions.values()].flatMap((session) => {
          const owner = ownedBy(session);
          return owner === undefined ? [] : [{ session, owner }];
        });
        const projects = new Set(owned.map(({ owner }) => owner.projectId));
        const present = new Map(
          yield* Effect.forEach(
            projects,
            (projectId) =>
              Effect.map(
                presentIn(projectId),
                (folders) => [projectId, folders] as const,
              ),
            { concurrency: "unbounded" },
          ),
        );
        const missing = new Set<string>();
        for (const { session, owner } of owned) {
          const folders = present.get(owner.projectId);
          if (folders === null || folders === undefined) continue;
          const path = folders.get(owner.worktreeId);
          if (path === undefined || !(yield* exists(path))) {
            missing.add(session.terminal.terminalId);
          }
        }
        yield* closeAll((session) => missing.has(session.terminal.terminalId));
      }).pipe(Effect.withSpan("Terminals.closeMissing")),
      closeEvery: closeAll(() => true),
    });
  });

export const layer = <R, E>(options: Parameters<typeof make<R, E>>[0]) =>
  Layer.effect(Terminals, make(options));
