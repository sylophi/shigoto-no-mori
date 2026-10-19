// The shell's hold on its host: an Electron utility process
// (host/process/host.ts) it forks with its facts, serves calls back to
// over a port (packages/contracts/src/modules/shellCalls.ts), and talks
// to over the loopback like any device, through the session
// (modules/session.ts). A host that exits unasked is forked again, and
// told again what the shell knows; the windows' links redial it. The
// hold is a layer of the shell's graph (shellLayer.ts): it forks the
// host as it comes up, and its closing asks the host to quit and closes
// the port server.
import { flavor } from "./flavor";
import { join } from "node:path";
import {
  app,
  MessageChannelMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { WebSocket as WsWebSocket } from "ws";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { sessionContract } from "@shigomori/contracts/modules/session";
import {
  type HostFailureSchema,
  shellCallsContract,
} from "@shigomori/contracts/modules/shellCalls";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import {
  type HostAddressSchema,
  type HostRestartReasonSchema,
  windowContract,
} from "@shigomori/contracts/modules/window";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { effectClient } from "@shared/ipc/effectClient";
import { log } from "@shared/log";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import { connectHost } from "@shared/remote/hostLink";
import { HOST_FACTS_FLAG, type HostFacts } from "@shared/hostFacts";
import { appPlace } from "./electron/appPlace";
import { migrationFailed, noteMigration } from "./electron/migration";
import { showMoveFailed } from "./electron/moveFailed";
import { relaunchAppUnattended } from "./electron/relaunch";
import { onGuide } from "./electron/guide";
import { currentUpdaterState, updaterCalls } from "./electron/updater";
import { releaseUpdaterBridge } from "./electron/updaterBridge";
import { accountFactsForHost, retryParkedSignOut } from "./electron/account";
import { makePortServer } from "./ipc/ShellLink";
import { broadcastAll } from "./ipc/register";
import { createShellRegistrar } from "./ipc/shellRegistrar";
import { deviceIdWithin } from "./core/host/deviceId";
import { beats, busyWithin, watchHost } from "./core/host/watchdog";
import { clearLoopbackOf } from "./core/host/leftovers";
import { lastEndedSpans, restartDetail } from "./core/host/restartLog";
import { CRASH_WINDOW_MS, restartLedger } from "./core/host/restarts";
import { busyAsks } from "./core/host/busyAsks";
import { type HostBeat, isHostBeat } from "@shared/hostBeat";
import { dataDir } from "@shared/paths";

type Address = typeof HostAddressSchema.Type;

// The host's address as the host reports it: the windows' token, and
// the shell's own, which no window is handed.
type Reported = Address & { readonly shellToken: string };

// A promise and its resolve, settled by whoever learns the value.
function deferred<A>(): {
  promise: Promise<A>;
  resolve: (value: A) => void;
  settled: () => boolean;
} {
  let resolve!: (value: A) => void;
  let settled = false;
  const promise = new Promise<A>((settle) => {
    resolve = (value) => {
      settled = true;
      settle(value);
    };
  });
  return { promise, resolve, settled: () => settled };
}

export type HostFailure = typeof HostFailureSchema.Type;

function hostFacts(): HostFacts {
  return {
    ...appPlace(),
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    logsPath: app.getPath("logs"),
    rendererOrigin: rendererSchemeOrigin(flavor),
    flavor,
  };
}

// How long a quit waits for the host to close its graph and exit.
const QUIT_DEADLINE_MS = 15_000;
// A host that is up is asked something cheap this often, and one that
// stays silent this long is killed and forked again.
const WATCH_EVERY = "10 seconds";
const SILENT_LIMIT_S = 30;
// A host that is starting has no link to ask yet: its loop beats on
// its parent port (host.ts) from the moment it runs, and one whose
// beats stop this long before it is up is killed. Longer than the
// running limit, since a start may import a store in one go. A second
// start in a row that stalls is the failure, said and shown, rather
// than a loop of starts.
const START_SILENT_LIMIT_S = 60;
const START_STALLS_ALLOWED = 1;
// How long a killed host is given to exit before it is killed outright
// (a host stopped by a signal never sees the first).
const KILL_GRACE_MS = 5_000;
// How long a restart waits on clearing what the host before it left.
const CLEAR_WITHIN_MS = 2_000;
// How long a quit or an update waits to hear whether the host is busy.
const BUSY_DEADLINE = "3 seconds";
type HostBusy = Effect.Success<ReturnType<ReturnType<typeof host>["busy"]>>;
const IDLE: HostBusy = {
  runningScripts: 0,
  inflightDeletes: 0,
  inflightMoves: 0,
  engineChanges: [],
  busyTerminals: 0,
};

let child: UtilityProcess | null = null;
let quitting = false;
let windowFocused = false;
type PortServer = Effect.Success<ReturnType<typeof makePortServer>>;
let server: PortServer | null = null;
let started = false;
const restarts = restartLedger();
// The current host's address, once it is up. Replaced as a host forks,
// so a window redialing meanwhile waits for the next one.
let address = deferred<Reported>();
let reportedDeviceId: string | undefined;
let onFailed: (failure: HostFailure) => void = () => {};
// A host that couldn't start as the migration's page showed: left down,
// the page saying why, until the page's Retry starts one again once it
// has exited. `parkedExit` settles as it exits; `nextPark` as the next
// host is parked, for a Retry that came first.
let parkedExit: Promise<void> | null = null;
let nextPark = deferred<void>();
let restarting: Promise<void> | null = null;
// The host that last said it is up, and the starts in a row since then
// that stalled before one did.
let upHost: UtilityProcess | null = null;
let startStalls = 0;
// The host whose stalled starts were given up on, left down.
let stalledOut: UtilityProcess | null = null;
// Each host's last beat, and why the shell stopped it when it did.
type Held = {
  lastBeat: { readonly at: number; readonly beat: HostBeat } | null;
  stoppedFor: HostRestartReason | null;
};
type HostRestartReason = typeof HostRestartReasonSchema.Type;
const held = new WeakMap<UtilityProcess, Held>();
// Why the host was last started again, told to the windows once the
// new one is up.
let restartedFor: HostRestartReason | null = null;
// The hold's fibers (the watchdogs, the words to the host), which end
// with it.
let runFork: (effect: Effect.Effect<unknown>) => void = () => {};

// A host's end in main.log: why, then what it was in at its last beat
// and the spans it last finished. Whether another starts is the exit's
// to say (fork's "starting it again").
function noteStop(running: UtilityProcess, why: string): void {
  log.warn(`[host] ${why}`);
  const beat = held.get(running)?.lastBeat ?? null;
  const now = performance.now();
  void lastEndedSpans(app.getPath("logs")).then((ended) => {
    for (const line of restartDetail({ beat, now, ended })) log.info(line);
  });
}

// The shell stops a host that went silent, and starts another.
function stopSilent(running: UtilityProcess, seconds: number): void {
  const state = held.get(running);
  const reason: HostRestartReason = { kind: "silent", seconds };
  if (state !== undefined) state.stoppedFor = reason;
  noteStop(running, `silent for ${seconds} s, stopping it`);
  killHard(running);
}

// The shell's link to the current host, made on first use: a window
// may ask before the hold is up, and waits for the host's address.
let dialed: ReturnType<typeof connectHost> | undefined;
const link = () =>
  (dialed ??= connectHost({
    // The shell dials with its own token, which opens its session.
    address: () =>
      address.promise.then(({ shellToken, ...rest }) => ({
        ...rest,
        token: shellToken,
      })),
    appVersion: app.getVersion(),
    // The `ws` package, like the host's own peer dials. It sends no
    // Origin, which the loopback admits.
    openSocket: (url) => new WsWebSocket(url),
  }));
// The session with the current host, waiting for one to be up.
export const host = () => effectClient(sessionContract, link());

// A word to the host that nothing waits on. A host that went away
// meanwhile hears it again as its successor starts.
function tell(said: Effect.Effect<unknown, unknown>): void {
  runFork(
    said.pipe(
      Effect.catch((error) =>
        Effect.sync(() => log.warn("[host] could not tell the host:", error)),
      ),
    ),
  );
}

// What the host asks of the shell.
const registrar = createShellRegistrar();
const shellCalls: Handlers<typeof shellCallsContract, HandlerContext> = {
  ready: (reported) => {
    restarts.up();
    upHost = child;
    startStalls = 0;
    reportedDeviceId = reported.deviceId;
    address.resolve(reported);
    if (restartedFor !== null) {
      broadcastAll(windowContract, "hostRestarted", restartedFor);
      restartedFor = null;
    }
    if (started) {
      link().reconnect();
    } else {
      started = true;
      // A sign-out whose revoke never reached the hub, delivered once a
      // host is up to name the device.
      void retryParkedSignOut();
    }
    // A new host knows nothing yet: the account, which brings its hub
    // socket up, the focus and the updater's state. Through the link,
    // whose calls wait for it to reach this host.
    tell(host().account(accountFactsForHost()));
    tell(host().windowFocused(windowFocused));
    tell(host().updaterState(currentUpdaterState()));
    const watched = child;
    if (watched !== null) {
      runFork(
        watchHost({
          probe: host().busy(),
          every: WATCH_EVERY,
          limit: `${SILENT_LIMIT_S} seconds`,
          watching: () => child === watched && !quitting,
          asleep: () => asleep,
          sleeps: () => sleeps,
          silent: () => stopSilent(watched, SILENT_LIMIT_S),
        }),
      );
    }
  },
  failed: (failure) => {
    if (migrationFailed(failure)) {
      const failing = child;
      parkedExit = new Promise((resolve) => {
        if (failing === null) resolve();
        else failing.once("exit", () => resolve());
      });
      nextPark.resolve();
      return;
    }
    onFailed(failure);
  },
  migration: (progress) => noteMigration(progress),
  relaunch: () => relaunchAppUnattended(),
  moveFailed: ({ reason }) => showMoveFailed(reason),
  updaterCheck: () => updaterCalls.check(),
  updaterInstall: ({ unattended }) => updaterCalls.install(unattended),
  updaterUpdate: ({ unattended }) => updaterCalls.update(unattended),
  stopUpdaterBridge: () => releaseUpdaterBridge(),
  guide: ({ session: token, action }) =>
    onGuide((guide) => guide.drive(token, action)),
};

// Asks the host to exit, and makes it once the grace runs out.
function killHard(running: UtilityProcess): void {
  const pid = running.pid;
  let exited = false;
  running.once("exit", () => {
    exited = true;
  });
  running.kill();
  if (pid === undefined) return;
  setTimeout(() => {
    if (exited) return;
    log.warn(`[host] ${pid} did not exit when asked, killing it`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone meanwhile.
    }
  }, KILL_GRACE_MS).unref();
}

function fork(): void {
  const { port1, port2 } = new MessageChannelMain();
  const replacesHosts = restarts.replacesHosts();
  const facts: HostFacts =
    replacesHosts.length === 0
      ? hostFacts()
      : { ...hostFacts(), replacesHosts };
  const forked = utilityProcess.fork(
    join(__dirname, "host.js"),
    [`${HOST_FACTS_FLAG}${JSON.stringify(facts)}`],
    { serviceName: "Shigoto no Mori Host", stdio: "pipe" },
  );
  child = forked;
  const state: Held = { lastBeat: null, stoppedFor: null };
  held.set(forked, state);
  // Read at its spawn: an exited utility process's pid reads undefined.
  let spawned: { pid: number; startedAt: number } | undefined;
  forked.once("spawn", () => {
    if (forked.pid !== undefined) {
      // An instant, which the host's orphan sweep compares with when a
      // script's process started.
      spawned = {
        pid: forked.pid,
        startedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      };
    }
  });
  // The host's console, into the shell's (and so its log file).
  for (const stream of [forked.stdout, forked.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line !== "") console.log(`[host] ${line}`);
      }
    });
  }
  if (server !== null) void Effect.runPromise(server.attach(port1, null));
  forked.postMessage(null, [port2]);
  // Its loop's beats, until it is up (START_SILENT_LIMIT_S).
  const beat = beats();
  forked.on("message", (message: unknown) => {
    if (isHostBeat(message)) {
      state.lastBeat = { at: performance.now(), beat: message };
    }
    beat.beat();
  });
  runFork(
    watchHost({
      probe: beat.next,
      every: WATCH_EVERY,
      limit: `${START_SILENT_LIMIT_S} seconds`,
      watching: () =>
        child === forked &&
        upHost !== forked &&
        !quitting &&
        parkedExit === null,
      asleep: () => asleep,
      sleeps: () => sleeps,
      silent: () => {
        startStalls += 1;
        if (startStalls > START_STALLS_ALLOWED) {
          // Not forked again: the failure is what follows.
          stalledOut = forked;
          const message = `The host stopped responding while it started, ${startStalls} times in a row.`;
          log.error(`[host] ${message}`);
          killHard(forked);
          onFailed({ message, store: null });
          return;
        }
        stopSilent(forked, START_SILENT_LIMIT_S);
      },
    }),
  );
  forked.once("exit", (code) => {
    if (child === forked) child = null;
    if (quitting || parkedExit !== null) return;
    // Gone unasked: what it published of its loopback names a port
    // nobody serves. A quit's host takes its own away (Loopback.ts).
    // Cleared before the next host starts, so it can't take that host's
    // own file, and only waited on so long: a data dir that holds it
    // holds the next host too, which the start watch then sees.
    const cleared =
      spawned === undefined
        ? Promise.resolve()
        : Promise.race([
            clearLoopbackOf(dataDir(), spawned.pid),
            new Promise<void>((resolve) =>
              setTimeout(resolve, CLEAR_WITHIN_MS).unref(),
            ),
          ]);
    if (stalledOut === forked) return;
    if (state.stoppedFor === null) {
      noteStop(forked, `exited unasked (code ${code})`);
    }
    // One that died before it was up leaves its waiters to the next.
    if (address.settled()) address = deferred<Reported>();
    const verdict = restarts.exited(spawned, performance.now());
    if (verdict.kind === "give-up") {
      onFailed({
        message: `The host stopped ${verdict.crashes} times in a minute.`,
        store: null,
      });
      return;
    }
    restartedFor = state.stoppedFor ?? { kind: "exited", code };
    log.warn("[host] starting it again");
    void cleared.then(() => {
      if (!quitting) fork();
    });
  });
}

// The host the migration's page is stuck on started again, once it is
// parked and has exited: one start for every Retry that asks meanwhile.
export function restartParkedHost(): Promise<void> {
  restarting ??= nextPark.promise
    .then(() => parkedExit)
    .then(() => {
      parkedExit = null;
      nextPark = deferred<void>();
      restarting = null;
      restarts.retried();
      // Started again by hand, which no window needs told.
      restartedFor = null;
      if (!quitting) fork();
    });
  return restarting;
}

// The host's runtime calls a window makes, for the nuke the shell runs
// with no window (electron/headlessNuke.ts).
export const hostRuntime = () => effectClient(runtimeContract, link());

// An exit with no quit sequence (that nuke's): the host closes its
// graph first, which stops what it runs (the tunnel's connector among
// them), and is not forked again.
export const letHostGo = (): Promise<void> => Effect.runPromise(stop(true));

// What the host is busy with, as a quit or an update asks, within a
// few seconds. An ask older than the watchdog's limit says nothing of
// the host now.
const busy = busyAsks<UtilityProcess, HostBusy>({
  idle: IDLE,
  freshMs: SILENT_LIMIT_S * 1000,
  now: () => performance.now(),
});
export const hostBusy = (quitAfter: boolean) =>
  Effect.suspend(() =>
    busy.ask(child, busyWithin(host().busy(), BUSY_DEADLINE), quitAfter),
  );

// The machine is going to sleep, or woke: a watchdog round around
// either proves nothing (watchHost).
let asleep = false;
let sleeps = 0;
export function noteSleep(): void {
  asleep = true;
  sleeps += 1;
}
export function noteWake(): void {
  asleep = false;
  sleeps += 1;
}

export function hostAddress(): Promise<Address> {
  return address.promise.then(({ port, token, deviceId }) => ({
    port,
    token,
    deviceId,
  }));
}

// The device the host is, which the shell's account calls name: the
// last one reported, or one waited for as long as the restarts a
// minute allows.
export const hostDeviceId = (): Promise<string> =>
  Effect.runPromise(
    deviceIdWithin(reportedDeviceId, hostAddress, CRASH_WINDOW_MS),
  );

// The updater moved. A host that is not up yet hears it as it starts.
export function noteUpdaterState(state: UpdaterState): void {
  if (child !== null) tell(host().updaterState(state));
}

// Whether a window here is focused, kept to tell a host that forks
// later.
export function noteWindowFocused(focused: boolean): void {
  if (focused === windowFocused) return;
  windowFocused = focused;
  if (child !== null) tell(host().windowFocused(focused));
}

// A window here gained focus, told every time, also when focus moves
// from one of ours to another: the host reads the rows again for the
// window that comes back to them.
export function noteWindowGainedFocus(): void {
  windowFocused = true;
  if (child !== null) tell(host().windowFocused(true));
}

// Quit: the host closes its graph (its quit sequence) and exits. One
// that does not within the deadline is killed.
const stop = (hurried: boolean) =>
  Effect.suspend(() => {
    quitting = true;
    const running = child;
    if (running === null) return Effect.void;
    const exited = new Promise<void>((resolve) =>
      running.once("exit", () => resolve()),
    );
    if (busy.kills(running)) {
      running.kill();
      return Effect.promise(() => exited);
    }
    return host()
      .quit({ hurried })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            log.warn("[quit] the host did not take the quit:", error),
          ),
        ),
        // Beside the wait, not in the hold's scope, which is closing.
        Effect.forkChild,
        Effect.andThen(Effect.promise(() => exited)),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: QUIT_DEADLINE_MS,
          orElse: () => Effect.sync(() => void running.kill()),
        }),
      );
  });

// The hold, for the length of the shell's graph: the port the host
// calls the shell back on, and the host itself. `failed` hears a host
// that could not start; `hurried` is asked at the quit (an update
// install or a relaunch signals the host's scripts instead of waiting
// them out).
export const layer = (options: {
  readonly failed: (failure: HostFailure) => void;
  readonly hurried: () => boolean;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      onFailed = options.failed;
      runFork = yield* FiberSet.makeRuntime<never>();
      registrar.serve(shellCallsContract, shellCalls);
      server = yield* makePortServer(registrar, ShellCallsGroup);
      yield* Effect.acquireRelease(Effect.sync(fork), () =>
        stop(options.hurried()),
      );
    }),
  );
