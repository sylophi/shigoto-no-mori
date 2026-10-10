// The host's interactive shells. Each terminal is a login shell under a
// PTY (../scripts/pty.ts), a resource in a scope of its own under the
// layer's: closing it is closing that scope, whose release is the kill
// chain. A terminal belongs to a worktree, which it starts in with the
// environment the worktree's scripts get and closes with, or to the
// device, where it starts in the folder the last one was in. A quit
// saves each one's history and folder (SavedTerminals), and the next
// start opens a fresh shell there under that history.
//
// Its output goes out in chunks, numbered by `seq`, to every client
// attached, through a bounded PubSub: a client that stops taking holds
// the shell's output back rather than pile it up here, and the PTY is
// paused while the backlog is large. History is a ring of the latest
// chunks (./history.ts), which an attach replays first.
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
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processes from "../util/processes";
import * as PromiseAdapter from "../util/promiseAdapter";
import { type PtyHandle, PtySpawnError, spawn } from "../scripts/pty";
import { type History, makeHistory } from "./history";

type Size = { readonly cols: number; readonly rows: number };

// Where a terminal's shell starts and what it is given.
export type Start = {
  // The worktree's folder. A device's terminal has none of its own.
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const DEFAULT_SIZE: Size = { cols: 120, rows: 40 };
// Reads within a frame go out as one chunk (as a script's output does).
const BATCH = Duration.millis(16);
// Chunks a client may fall behind by before the shell's output waits
// for it.
const CLIENT_BACKLOG = 64;
// Output read from the PTY and not yet sent, past which the PTY is
// paused, and below which it reads again.
const PAUSE_AT = 1024 * 1024;
const RESUME_AT = 256 * 1024;
// A shell is stopped with SIGHUP, as when its window closes, and
// SIGKILL a moment later if it is still there.
const STOPPING = { graceMs: 1_000, wait: true, signal: "SIGHUP" } as const;
// What a restored history ends with, so the fresh shell's prompt lands
// on a clean screen: out of the alternate screen, the mouse and the
// keypad modes, with the cursor shown and the colors reset.
const RESTORED_TAIL =
  "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b>\x1b[?25h\x1b[0m\r\n";

interface Session {
  readonly terminal: Terminal;
  readonly pty: PtyHandle;
  readonly history: History;
  readonly events: PubSub.PubSub<TerminalEvent>;
  readonly scope: Scope.Closeable;
  seq: number;
  size: Size;
  exited: Option.Option<number | null>;
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
    // Closes the terminals whose worktree, or its project, is gone.
    readonly closeMissing: Effect.Effect<void>;
    // How many terminals run something in the foreground: what a quit
    // asks about.
    readonly busy: Effect.Effect<number>;
  }
>()("sm/host/Terminals") {}

const make = (options: {
  // The folder and environment a terminal starts with: a worktree's
  // scripts', or the app's own for the device's.
  readonly start: (
    owner: TerminalOwner,
  ) => Effect.Effect<Start, UnknownProjectError | UnknownWorktreeError>;
}) =>
  Effect.gen(function* () {
    const layerScope = yield* Effect.scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
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
          if (data.length > 0) {
            session.seq += 1;
            session.history.append(session.seq, data);
            yield* PubSub.publish(session.events, {
              kind: "output",
              data,
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

    const begin = Effect.fnUntraced(function* (
      terminal: Terminal,
      env: Start["env"],
      size: Size,
      restored?: { readonly seq: number; readonly history: string },
    ) {
      const scope = yield* Scope.fork(layerScope);
      return yield* Effect.gen(function* () {
        const pty = yield* spawn(
          { command: null, cwd: terminal.cwd, env, ...size },
          () => STOPPING,
        ).pipe(
          Scope.provide(scope),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
        );
        const session: Session = {
          terminal,
          pty,
          history: makeHistory(
            restored?.seq ?? 0,
            restored === undefined ? "" : restored.history + RESTORED_TAIL,
          ),
          events: yield* PubSub.bounded<TerminalEvent>(CLIENT_BACKLOG),
          scope,
          seq: restored?.seq ?? 0,
          size,
          exited: Option.none(),
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
        // A shell that dies of a signal has no code to tell.
        pty.onExit(({ exitCode, signal }) => {
          Queue.offerUnsafe(reads, {
            exit: signal !== undefined && signal !== 0 ? null : exitCode,
          });
        });
        yield* Effect.forkIn(pump(session, reads, backlog), scope);
        // Runs first as the scope closes, while the shell is still there
        // to be asked where it is.
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            const folder = yield* folderOf(session);
            if (terminal.owner.kind === "device" && Option.isSome(folder)) {
              yield* saved.setLastFolder(folder.value);
            }
            if (session.forget) {
              yield* saved.forget(terminal.terminalId);
              return;
            }
            yield* saved.save({
              ...terminal,
              cwd: Option.getOrElse(folder, () => terminal.cwd),
              seq: session.seq,
              history: session.history.text(),
            });
          }),
        );
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
      const start = yield* options.start(input.owner);
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

    // What the last quit left, each in a fresh shell where it was. One
    // whose worktree is gone is dropped.
    const restore = Effect.gen(function* () {
      for (const terminal of yield* saved.list) {
        yield* saved.forget(terminal.terminalId);
        const start = yield* Effect.option(options.start(terminal.owner));
        if (Option.isNone(start)) continue;
        const cwd = (yield* exists(terminal.cwd))
          ? terminal.cwd
          : (start.value.cwd ?? home);
        yield* begin({ ...terminal, cwd }, start.value.env, DEFAULT_SIZE, {
          seq: terminal.seq,
          history: terminal.history,
        }).pipe(
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
      closeMissing: Effect.gen(function* () {
        const missing: string[] = [];
        for (const session of sessions.values()) {
          const owner = ownedBy(session);
          if (owner === undefined) continue;
          const start = yield* Effect.option(options.start(owner));
          if (
            Option.isNone(start) ||
            (start.value.cwd !== undefined && !(yield* exists(start.value.cwd)))
          ) {
            missing.push(session.terminal.terminalId);
          }
        }
        yield* closeAll((session) =>
          missing.includes(session.terminal.terminalId),
        );
      }),
    });
  });

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(Terminals, make(options));

// For the link's handlers and the worktree removals, which are not
// Effect yet.
const promiseAdapter = PromiseAdapter.forService(Terminals, "The terminals");
export const adapter = promiseAdapter.layer;

// Settles at once while the service is not up: there is nothing to
// close then.
// What a quit asks about.
export const busyTerminals = (): Promise<number> =>
  promiseAdapter
    .run(Effect.flatMap(Terminals, (terminals) => terminals.busy))
    .catch(() => 0);

export const closeMissingTerminals = () =>
  promiseAdapter.runIfOpen(
    Effect.flatMap(Terminals, (terminals) => terminals.closeMissing),
  );

// A stream of the service's, for the views the link serves.
export const stream = <A, E>(
  f: (terminals: Terminals["Service"]) => Stream.Stream<A, E>,
): Stream.Stream<A, E> =>
  Stream.unwrap(
    Effect.promise(() =>
      promiseAdapter.call((terminals) => Effect.succeed(f(terminals))),
    ),
  );

// One of the service's calls, for the handlers the link serves.
export const call = promiseAdapter.call;
