// The host's interactive shells. Each terminal is a login shell under a
// PTY (../scripts/ScriptRuns.ts), a resource in a scope of its own under the
// layer's: closing it is closing that scope, whose release is the kill
// chain. A terminal belongs to a worktree, which it starts in with the
// environment the worktree's scripts get and closes with. Its main
// screen and folder are saved (SavedTerminals) a moment after its
// output changes and again as it closes, so after a quit or a crash the
// next start opens a fresh shell there under that screen.
//
// Its output goes out in chunks, numbered by `seq`, to every client
// attached, through a bounded PubSub: a client that falls behind holds
// the shell's output back rather than pile it up here, and the PTY is
// paused while the backlog is large. One that stops taking is cut
// loose after a moment, and catches up from the history, a ring of the
// latest chunks (./history.ts), while it still holds the client's last
// one. Any other attach is sent the screen as it is (./screen.ts).
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import {
  UnknownProjectError,
  UnknownTerminalError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import type {
  GridSize,
  Terminal,
  TerminalEvent,
} from "@shigomori/contracts/schemas";
import * as SavedTerminals from "@shigomori/engine/SavedTerminals";
import { elapsedMillis } from "@shigomori/engine/elapsed";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processes from "@shigomori/engine/processes";
import { byPlatform } from "@shigomori/engine/platform";
import { type PtyHandle, PtySpawnError, spawn } from "../scripts/ScriptRuns";
import { type History, makeHistory } from "./history";
import { makeScreen, type Screen } from "./screen";

// `words` random 32-bit words as hex.
const mintHex = (words: number) =>
  Effect.map(
    Effect.all(
      Array.from({ length: words }, () => Random.nextIntBetween(0, 0xffffffff)),
    ),
    (parts) => parts.map((part) => part.toString(16).padStart(8, "0")).join(""),
  );

// The worktree a terminal belongs to.
type Owner = Pick<Terminal, "projectId" | "worktreeId">;

// A terminal to open: its worktree, the grid the opener has room for,
// and a command line typed into its shell (a launched terminal tool).
type OpenInput = Owner & {
  readonly size?: GridSize | undefined;
  readonly command?: string;
};

// Where a terminal's shell starts (its worktree's folder) and what it is
// given.
export type Start = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const DEFAULT_SIZE: GridSize = { cols: 120, rows: 40 };

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
// The reads a write comes in go out as one chunk once they pause for
// QUIET, a BATCH after the last chunk at the soonest, or a BATCH after
// they began while they keep coming (a flood). A program's redraw
// arrives as many small reads over a millisecond or two, and sent in
// pieces it would show half drawn. One that marks its frames
// (synchronized output) has each go out as soon as it ends, so a
// fullscreen TUI's scroll reaches the screen at the rate it draws.
const QUIET = Duration.millis(2);
const BATCH = Duration.millis(16);
const FRAME_END = "\x1b[?2026l";
// Chunks a client may fall behind by before the shell's output waits
// for it, and how long it waits for a client that takes none.
const CLIENT_BACKLOG = 64;
const CLIENT_STALL = Duration.seconds(2);
// The longest the list and lookups wait for the restore, which one
// project on a hung volume could hold up for every terminal.
const RESTORE_WAIT = Duration.seconds(5);
// The most one chunk holds, in UTF-16 code units: at most 768 KiB as
// UTF-8, so a chunk fits a message of the stream it goes out on
// (host/socket/boundedMessages.ts). A batch past it goes as several.
const CHUNK_MAX = 256 * 1024;
// Output read from the PTY and not yet sent, past which the PTY is
// paused, and below which it reads again.
const PAUSE_AT = 1024 * 1024;
const RESUME_AT = 256 * 1024;
// Output the screen may have yet to parse before the next read waits
// for it. Frames don't wait, and a flood goes at the pace it is parsed.
const SCREEN_BEHIND = 1024 * 1024;
// A terminal's changed screen is saved once its output has been quiet
// this long, and at least this often while it keeps changing (a flood,
// an agent CLI's spinner): what a crash may lose, against one write of
// the whole screen each time. Both count awake time, so a clock step moves
// no save and a sleep spends none of the minute.
const SAVE_QUIET = Duration.seconds(2);
const SAVE_AT_MOST = Duration.minutes(1);
// A shell is stopped with SIGHUP, as when its window closes, and
// SIGKILL a moment later if it is still there.
const STOPPING = { graceMs: 1_000, wait: true, signal: "SIGHUP" } as const;
// How often the shells are asked whether a command holds them.
const BUSY_EVERY = Duration.seconds(2);
// A private mode set or reset (CSI in seven or eight bits), its modes as
// they come (`1049;25`), a kitty keyboard set, push or pop (`=`, `>`,
// `<`) with its numbers, or a full reset, which leaves the alternate
// screen too.
// A control character inside one is carried out and skipped, as a
// terminal does, but CAN and SUB end it.
const SCREEN_MODES = new RegExp(
  String.raw`(?:\x1b\[|\x9b)\?([\d;\x00-\x17\x19\x1c-\x1f]+)([hl])|(?:\x1b\[|\x9b)([=><])([\d;]*)u|\x1bc`,
  "g",
);
// The start of a sequence the output so far hasn't finished: a CSI, or
// a string (OSC, DCS, APC, PM, SOS) not yet ended by BEL or ST.
const UNFINISHED = new RegExp(
  String.raw`(?:\x1b\[|\x9b)[\x00-\x17\x19\x1c-\x3f]*$|(?:\x1b[\]P_^X]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*\x1b?$|\x1b$`,
);
const ALTERNATE = new Set([1049, 1047, 47]);
// SGR mouse coordinates, which a snapshot of the screen doesn't carry.
const SGR_MOUSE = 1006;

// What a restored history ends with, so the fresh shell's prompt lands
// on its own line in the default colors.
const RESTORED_TAIL = "\x1b[0m\r\n";

// The kitty keyboard flags a program asked for, kept as xterm keeps
// them: the shown screen's flags and stack, and the other screen's put
// by until it is shown again.
type Kitty = {
  readonly flags: number;
  readonly stack: readonly number[];
  readonly other: number;
  readonly otherStack: readonly number[];
};
const KITTY_OFF: Kitty = { flags: 0, stack: [], other: 0, otherStack: [] };
// xterm keeps the 16 latest pushes.
const KITTY_STACK_MAX = 16;

const otherScreen = (kitty: Kitty): Kitty => ({
  flags: kitty.other,
  stack: kitty.otherStack,
  other: kitty.flags,
  otherStack: kitty.stack,
});

const kittyAfter = (kitty: Kitty, op: string, numbers: string): Kitty => {
  const [first = 0, mode = 1] = numbers.split(";").map(Number);
  if (op === "=") {
    const flags =
      mode === 2
        ? kitty.flags | first
        : mode === 3
          ? kitty.flags & ~first
          : first;
    return { ...kitty, flags };
  }
  if (op === ">") {
    const stack = [...kitty.stack, kitty.flags].slice(-KITTY_STACK_MAX);
    return { ...kitty, flags: first, stack };
  }
  const left = kitty.stack.length - Math.max(1, first);
  return left <= 0
    ? { ...kitty, flags: 0, stack: [] }
    : {
        ...kitty,
        flags: kitty.stack[left] ?? 0,
        stack: kitty.stack.slice(0, left),
      };
};

// Whether a read leaves the terminal on the alternate screen, and the
// kitty keyboard flags and SGR mouse it leaves, from where the last one
// left them, with what of this one the next has to finish.
type Followed = {
  readonly alternate: boolean;
  readonly kitty: Kitty;
  readonly sgrMouse: boolean;
  readonly carry: string;
};

const followScreen = (before: Followed, data: string): Followed => {
  const seen = before.carry + data;
  let { alternate, kitty, sgrMouse } = before;
  for (const match of seen.matchAll(SCREEN_MODES)) {
    const [sequence, sequenceModes, set, op, numbers] = match;
    if (op !== undefined) {
      kitty = kittyAfter(kitty, op, numbers ?? "");
      continue;
    }
    if (sequence === "\x1bc") {
      alternate = false;
      kitty = KITTY_OFF;
      sgrMouse = false;
      continue;
    }
    const listed = (sequenceModes?.replace(/[^\d;]/g, "").split(";") ?? []).map(
      Number,
    );
    if (listed.includes(SGR_MOUSE)) sgrMouse = set === "h";
    if (!listed.some((mode) => ALTERNATE.has(mode))) continue;
    if (set === "h" ? !alternate : alternate) kitty = otherScreen(kitty);
    alternate = set === "h";
  }
  return {
    alternate,
    kitty,
    sgrMouse,
    carry: (UNFINISHED.exec(seen)?.[0] ?? "").slice(-256),
  };
};

// Where a terminal's output is up to, as the screen shows it.
type Shown = Followed & { readonly seq: number };

interface Session {
  // Replaced as its busy changes.
  terminal: Terminal;
  // The folder its shell started in.
  readonly cwd: string;
  readonly pty: PtyHandle;
  readonly history: History;
  readonly screen: Screen<Shown>;
  readonly events: PubSub.PubSub<TerminalEvent>;
  readonly scope: Scope.Closeable;
  // This shell's, minted as it starts: a client's seq means something
  // only in the incarnation it read.
  readonly incarnation: string;
  // Opened by output the store doesn't have yet, the last at
  // `changedAt` (elapsedMillis).
  readonly changed: Latch.Latch;
  changedAt: number;
  seq: number;
  size: GridSize;
  exited: Option.Option<number | null>;
  // Followed as output comes in, for what a snapshot of the screen
  // doesn't carry.
  followed: Followed;
  // Closed by its user or with its worktree, or its shell ended, so not
  // saved for the next start.
  forget: boolean;
}

export class Terminals extends Context.Service<
  Terminals,
  {
    // Every open terminal, oldest first, and again on each open and
    // close and as one's busy changes.
    readonly list: Stream.Stream<ReadonlyArray<Terminal>>;
    readonly open: (
      input: OpenInput,
    ) => Effect.Effect<
      Terminal,
      PtySpawnError | UnknownProjectError | UnknownWorktreeError
    >;
    readonly close: (
      terminalId: string,
    ) => Effect.Effect<void, UnknownTerminalError>;
    // The size and the history after `after` (the screen when that is
    // gone), then the output and the size as they change, then the
    // exit.
    readonly attach: (
      terminalId: string,
      after?: { readonly incarnation: string; readonly seq: number },
    ) => Stream.Stream<TerminalEvent, UnknownTerminalError>;
    readonly write: (
      terminalId: string,
      data: string,
    ) => Effect.Effect<void, UnknownTerminalError>;
    // The size every attached client draws at.
    readonly resize: (
      terminalId: string,
      size: GridSize,
    ) => Effect.Effect<void, UnknownTerminalError>;
    // How many live terminals are the worktree's.
    readonly openIn: (worktreeId: string) => number;
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
  // The folder and environment a terminal starts with: its worktree's
  // scripts'.
  readonly start: (
    owner: Owner,
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
    const startOf = (owner: Owner) =>
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
    const sessions = new Map<string, Session>();
    const listed = yield* SubscriptionRef.make<ReadonlyArray<Terminal>>([]);
    const announce = Effect.suspend(() =>
      SubscriptionRef.set(
        listed,
        [...sessions.values()].map((session) => session.terminal),
      ),
    );

    // Opens once the last run's terminals are back (restore), or
    // RESTORE_WAIT on. Until then neither the list nor a lookup
    // answers: a window attached across a restart would read its
    // terminal as closed.
    const back = yield* Latch.make(false);

    // A listed terminal, a dead one on its way out included (`live`
    // leaves it out).
    const listedSession = (terminalId: string, live = false) =>
      Latch.whenOpen(
        back,
        Effect.suspend(() => {
          const session = sessions.get(terminalId);
          return session === undefined ||
            (live && Option.isSome(session.exited))
            ? Effect.fail(new UnknownTerminalError({ terminalId }))
            : Effect.succeed(session);
        }),
      );
    const find = (terminalId: string) => listedSession(terminalId, true);
    const living = () =>
      [...sessions.values()].filter((session) => Option.isNone(session.exited));

    // The folder a shell is in now, read off the process: by lsof on a
    // Mac, and on Linux by the link the kernel keeps in /proc.
    const folderOf = (session: Session) => {
      const read: Effect.Effect<Option.Option<string>, unknown> = byPlatform({
        darwin: Processes.exec("lsof", [
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
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
        ),
        linux: fs
          .readLink(`/proc/${session.pty.pid}/cwd`)
          .pipe(Effect.map(Option.some)),
      });
      return read.pipe(
        Effect.timeout(Duration.seconds(2)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    };

    // The shells among `among` that a command holds: one is held while
    // its terminal's foreground process group is not its own. Fails
    // when `ps` does.
    const held = (among: readonly Session[]) =>
      Effect.gen(function* () {
        if (among.length === 0) return new Set<number>();
        const { stdout } = yield* Processes.exec("ps", [
          "-o",
          "pid=,tpgid=",
          "-p",
          among.map((session) => session.pty.pid).join(","),
        ]).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
        );
        return new Set(
          stdout
            .split("\n")
            .map((line) => line.trim().split(/\s+/).map(Number))
            .filter(([pid, tpgid = 0]) => tpgid > 0 && tpgid !== pid)
            .map(([pid = 0]) => pid),
        );
      });

    const exists = (path: string) =>
      fs.exists(path).pipe(Effect.orElseSucceed(() => false));

    // Takes the PTY's reads in frames, keeps them, and sends each frame
    // as a chunk, then the exit once the shell is gone.
    const pump = (
      session: Session,
      reads: Queue.Queue<string | number>,
      backlog: { bytes: number; paused: boolean },
    ) =>
      Effect.gen(function* () {
        const batch = Duration.toMillis(BATCH);
        let sentAt = Number.NEGATIVE_INFINITY;
        while (true) {
          const taken: Array<string | number> = [
            ...(yield* Queue.takeAll(reads)),
          ];
          const start = yield* elapsedMillis;
          let latest: ReadonlyArray<string | number> = taken;
          while (
            latest.every(
              (item) => typeof item === "string" && !item.includes(FRAME_END),
            ) &&
            (yield* elapsedMillis) - start < batch
          ) {
            const next = yield* Queue.takeAll(reads).pipe(
              Effect.timeoutOption(QUIET),
            );
            if (Option.isSome(next)) {
              latest = next.value;
              taken.push(...latest);
            } else if ((yield* elapsedMillis) - sentAt >= batch) {
              break;
            }
          }
          sentAt = yield* elapsedMillis;
          let data = "";
          let ended: Option.Option<number> = Option.none();
          for (const item of taken) {
            if (typeof item === "string") data += item;
            else ended = Option.some(item);
          }
          backlog.bytes -= data.length;
          if (backlog.paused && backlog.bytes < RESUME_AT) {
            backlog.paused = false;
            session.pty.resume();
          }
          session.followed = followScreen(session.followed, data);
          const chunks = pieces(data);
          // Queued before any goes out, so an attach's snapshot has all
          // the chunks it missed.
          session.screen.write(data, {
            ...session.followed,
            seq: session.seq + chunks.length,
          });
          for (const piece of chunks) {
            session.seq += 1;
            session.history.append(session.seq, piece);
            session.changedAt = yield* elapsedMillis;
            session.changed.openUnsafe();
            yield* PubSub.publish(session.events, {
              kind: "output",
              data: piece,
              seq: session.seq,
            });
          }
          if (session.screen.behind() > SCREEN_BEHIND) {
            yield* session.screen.parsed;
          }
          if (Option.isSome(ended)) {
            session.exited = Option.some(ended.value);
            session.forget = true;
            yield* PubSub.publish(session.events, {
              kind: "exit",
              code: ended.value,
            });
            // A shell that ended goes with its tab, whatever its status
            // or signal. It ends from outside this fiber, which is in its
            // scope.
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

    // The terminal as it is now, in the store: its folder and its
    // history. One row, written at once, so a crash leaves the last one
    // whole.
    const persist = Effect.fnUntraced(function* (session: Session) {
      const folder = yield* folderOf(session);
      yield* saved.save({
        ...session.terminal,
        cwd: Option.getOrElse(folder, () => session.cwd),
        seq: session.seq,
        history: yield* session.screen.saved,
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
            const now = yield* elapsedMillis;
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
      { cwd, env }: Start,
      size: GridSize,
      restored?: { readonly seq: number; readonly history: string },
    ) {
      const scope = yield* Scope.fork(layerScope);
      return yield* Effect.gen(function* () {
        const pty = yield* spawn(
          {
            command: null,
            cwd,
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
        // A restored history is a chunk of its own in a new incarnation,
        // so a client that saw the shell before the restart starts over.
        const first = restored === undefined ? 0 : restored.seq + 1;
        const followed: Followed = {
          alternate: false,
          kitty: KITTY_OFF,
          sgrMouse: false,
          carry: "",
        };
        const session: Session = {
          terminal,
          cwd,
          pty,
          incarnation: yield* mintHex(4),
          history: makeHistory(first),
          screen: makeScreen(
            size,
            restored === undefined ? "" : restored.history + RESTORED_TAIL,
            { ...followed, seq: first },
          ),
          events: yield* PubSub.bounded<TerminalEvent>(CLIENT_BACKLOG),
          scope,
          changed: Latch.makeUnsafe(false),
          changedAt: 0,
          seq: first,
          size,
          exited: Option.none(),
          followed,
          forget: false,
        };
        yield* Scope.addFinalizer(scope, PubSub.shutdown(session.events));
        // Its output, then its exit status.
        const reads = yield* Queue.unbounded<string | number>();
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
        // A shell that dies of a signal reads 128 + its number, as a
        // shell tells a child's.
        pty.onExit(({ exitCode, signal }) => {
          Queue.offerUnsafe(reads, signal ? 128 + signal : exitCode);
        });
        yield* Effect.forkIn(pump(session, reads, backlog), scope);
        // Runs as the scope closes, while the shell is still there to be
        // asked where it is, after the saver (forked below) has stopped.
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            if (!session.forget) return yield* persist(session);
            yield* saved.forget(terminal.terminalId);
          }),
        );
        yield* Effect.forkIn(keepSaved(session), scope);
        sessions.set(terminal.terminalId, session);
        yield* announce;
        return session;
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });

    const mintId = mintHex(2);

    const open = Effect.fn("Terminals.open")(function* (input: OpenInput) {
      const start = yield* startOf(input);
      const terminal: Terminal = {
        terminalId: yield* mintId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        openedAt: yield* Clock.currentTimeMillis,
        busy: false,
      };
      yield* Effect.annotateCurrentSpan({ terminalId: terminal.terminalId });
      const session = yield* begin(terminal, start, input.size ?? DEFAULT_SIZE);
      // Typed before the shell is up, as a terminal app's launch is: the
      // shell reads it as its first line, and stays after it exits.
      if (input.command !== undefined) session.pty.write(`${input.command}\r`);
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
      for (const { cwd, seq, history, ...terminal } of yield* saved.list) {
        const start = yield* Effect.option(startOf(terminal));
        if (Option.isNone(start)) {
          yield* saved.forget(terminal.terminalId);
          continue;
        }
        const folder = (yield* exists(cwd)) ? cwd : start.value.cwd;
        yield* begin(
          { ...terminal, busy: false },
          { ...start.value, cwd: folder },
          DEFAULT_SIZE,
          {
            seq,
            history,
          },
        ).pipe(
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
      Effect.ensuring(Latch.open(back)),
      Effect.forkIn(layerScope),
    );
    yield* Latch.open(back).pipe(
      Effect.delay(RESTORE_WAIT),
      Effect.forkIn(layerScope),
    );

    // Whether each shell is busy, sent with the list when one changes. A
    // look that fails leaves them as they were.
    yield* Effect.gen(function* () {
      const shells = living();
      const pids = yield* held(shells);
      let changed = false;
      for (const session of shells) {
        const busy = pids.has(session.pty.pid);
        if (busy === session.terminal.busy) continue;
        session.terminal = { ...session.terminal, busy };
        changed = true;
      }
      if (changed) yield* announce;
    }).pipe(
      Effect.ignoreCause,
      Effect.repeat(Schedule.spaced(BUSY_EVERY)),
      Effect.forkIn(layerScope),
    );

    // A client's events from `after`: the size, the history after it
    // (which xterm parses at the size it has when the history arrives),
    // then the events as they come. A client that takes nothing for a
    // while is unsubscribed, so it holds no one else's output back, and
    // starts again after the last chunk it took once it takes again.
    const attached = (
      session: Session,
      after: { readonly incarnation: string; readonly seq: number } | undefined,
    ): Stream.Stream<TerminalEvent> => {
      let from = after;
      let stalled = false;
      const round = Stream.unwrap(
        Effect.gen(function* () {
          stalled = false;
          const opening = (
            size: GridSize,
            past: { data: string; seq: number; reset: boolean },
          ) => ({
            past,
            head: [
              { kind: "size", ...size },
              { kind: "history", incarnation: session.incarnation, ...past },
            ] satisfies TerminalEvent[],
          });
          const headOf = Effect.gen(function* () {
            const since =
              from?.incarnation === session.incarnation
                ? session.history.since(from.seq)
                : undefined;
            if (since !== undefined) {
              return opening(session.size, { ...since, reset: false });
            }
            // A client starting over gets the screen, then the kitty
            // keyboard flags and the SGR mouse, which the screen doesn't
            // carry, then the sequence its last output left unfinished
            // for the next to finish.
            const { data, size, at } = yield* session.screen.snapshot;
            const mouse = at.sgrMouse ? `\x1b[?${SGR_MOUSE}h` : "";
            return opening(size, {
              data: `${data}\x1b[=${at.kitty.flags}u${mouse}${at.carry}`,
              seq: at.seq,
              reset: true,
            });
          });
          // A dead one, on its way out, gets its exit from here, not
          // from its events.
          if (Option.isSome(session.exited)) {
            return Stream.fromIterable([
              ...(yield* headOf).head,
              { kind: "exit", code: session.exited.value },
            ] satisfies TerminalEvent[]);
          }
          const subscribed = yield* Scope.fork(yield* Effect.scope);
          const live = yield* PubSub.subscribe(session.events).pipe(
            Scope.provide(subscribed),
          );
          // A chunk sent between the subscription and this read is in
          // both, and the seq tells which.
          const { past, head } = yield* headOf;
          from = { incarnation: session.incarnation, seq: past.seq };
          const taken = yield* Queue.bounded<TerminalEvent, Cause.Done>(
            CLIENT_BACKLOG,
          );
          yield* Stream.fromSubscription(live).pipe(
            Stream.runForEach((event) =>
              Queue.offer(taken, event).pipe(Effect.timeout(CLIENT_STALL)),
            ),
            Effect.catch(() =>
              Effect.sync(() => {
                stalled = true;
              }),
            ),
            Effect.ensuring(
              Scope.close(subscribed, Exit.void).pipe(
                Effect.andThen(Queue.end(taken)),
              ),
            ),
            Effect.forkScoped,
          );
          return Stream.fromIterable(head).pipe(
            Stream.concat(
              Stream.fromQueue(taken).pipe(
                Stream.filter(
                  (event) => event.kind !== "output" || event.seq > past.seq,
                ),
                Stream.tap((event) =>
                  Effect.sync(() => {
                    if (event.kind === "output") {
                      from = {
                        incarnation: session.incarnation,
                        seq: event.seq,
                      };
                    }
                  }),
                ),
                Stream.takeUntil((event) => event.kind === "exit"),
              ),
            ),
          );
        }),
      );
      // Each round's scope closes before the next starts.
      return round.pipe(
        Stream.repeat(Schedule.forever.pipe(Schedule.while(() => stalled))),
      );
    };

    return Terminals.of({
      list: Stream.unwrap(
        Latch.whenOpen(back, Effect.succeed(SubscriptionRef.changes(listed))),
      ),
      open,
      close: Effect.fn("Terminals.close")(function* (terminalId: string) {
        const session = yield* listedSession(terminalId);
        session.forget = true;
        yield* end(session);
      }),
      attach: (terminalId, after) =>
        Stream.unwrap(
          Effect.map(listedSession(terminalId), (session) =>
            attached(session, after),
          ),
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
        size: GridSize,
      ) {
        const session = yield* find(terminalId);
        if (
          size.cols === session.size.cols &&
          size.rows === session.size.rows
        ) {
          return;
        }
        session.size = size;
        session.screen.resize(size);
        yield* Effect.sync(() => session.pty.resize(size.cols, size.rows)).pipe(
          Effect.ignore,
        );
        yield* PubSub.publish(session.events, { kind: "size", ...size });
      }),
      busy: Effect.suspend(() => held(living())).pipe(
        Effect.map((pids) => pids.size),
        Effect.orElseSucceed(() => 0),
        Effect.withSpan("Terminals.busy"),
      ),
      openIn: (worktreeId) =>
        living().filter(({ terminal }) => terminal.worktreeId === worktreeId)
          .length,
      closeMissing: Effect.gen(function* () {
        const owned = [...sessions.values()];
        const projects = new Set(
          owned.map((session) => session.terminal.projectId),
        );
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
        for (const session of owned) {
          const folders = present.get(session.terminal.projectId);
          if (folders === null || folders === undefined) continue;
          const path = folders.get(session.terminal.worktreeId);
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
