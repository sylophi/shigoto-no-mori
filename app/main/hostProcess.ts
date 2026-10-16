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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { WebSocket as WsWebSocket } from "ws";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import { sessionContract } from "@shigomori/contracts/modules/session";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { HostRestartReasonSchema } from "@shigomori/contracts/modules/window";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { effectClient } from "@shared/ipc/effectClient";
import { log } from "@shared/log";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import { connectHost } from "@shared/remote/hostLink";
import { HOST_FACTS_FLAG, type HostFacts } from "@shared/hostFacts";
import { appPlace } from "./electron/appPlace";
import { migrationFailed, noteMigration } from "./ipc/modules/migration";
import { showMoveFailed } from "./electron/moveFailed";
import { relaunchAppUnattended } from "./electron/relaunch";
import { onGuide } from "./electron/guide";
import { currentUpdaterState, updaterCalls } from "./electron/updater";
import { stopUpdaterBridge } from "./electron/updaterBridge";
import { accountFactsForHost, retryParkedSignOut } from "./ipc/modules/account";
import { makePortServer } from "./ipc/ShellLink";
import { createShellRegistrar } from "./ipc/shellRegistrar";
import { deviceIdWithin } from "./core/host/deviceId";
import { beats, busyWithin, watchHost } from "./core/host/watchdog";
import { clearLoopbackOf } from "./core/host/leftovers";
import { lastEndedSpans, restartDetail } from "./core/host/restartLog";
import { type HostBeat, isHostBeat } from "@shared/hostBeat";
import { dataDir } from "@shared/paths";

type Address = {
  readonly port: number;
  readonly token: string;
  readonly deviceId: string;
};

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

export type HostFailure = {
  readonly message: string;
  readonly storeReport: string | null;
};

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

// A host that keeps dying is given up on, rather than forked in a loop.
const CRASH_WINDOW_MS = 60_000;
const CRASHES_ALLOWED = 3;
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
const IDLE = { runningScripts: 0, inflightDeletes: 0 } as const;

let child: UtilityProcess | null = null;
let quitting = false;
let windowFocused = false;
type PortServer = Effect.Success<ReturnType<typeof makePortServer>>;
let server: PortServer | null = null;
let started = false;
const crashes: number[] = [];
// The current host's address, once it is up. Replaced as a host forks,
// so a window redialing meanwhile waits for the next one.
let address = deferred<Reported>();
// The hosts that exited unasked since one was last up, for the next to
// stop what their scripts left (HostFacts.replacesHosts).
let replaced: { pid: number; startedAt: number; exitedAt: number }[] = [];
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
// The restarts since the app started, and the last one's reason, which
// a window whose link came back asks for (window:hostRestarts).
let restarts = 0;
let restartReason: HostRestartReason | null = null;

// A host's end in main.log: why, then what it was in at its last beat
// and the spans it last finished. Whether another starts is the exit's
// to say (fork's "starting it again").
function noteStop(running: UtilityProcess, why: string): void {
  log.warn(`[host] ${why}`);
  const beat = held.get(running)?.lastBeat ?? null;
  const now = Date.now();
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

export const hostRestarts = () => ({ count: restarts, reason: restartReason });

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
const session = () => effectClient(sessionContract, link());

// A word to the host that nothing waits on. A host that went away
// meanwhile hears it again as its successor starts.
function tell(said: Effect.Effect<unknown, unknown>): void {
  Effect.runFork(
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
    // Up, its sweep has claimed what the hosts before it left.
    replaced = [];
    upHost = child;
    startStalls = 0;
    // The device the host is rides along, which the shell's account
    // calls name.
    reportedDeviceId = reported.deviceId;
    address.resolve(reported);
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
    tell(session().account(accountFactsForHost()));
    tell(session().windowFocused(windowFocused));
    tell(session().updaterState(currentUpdaterState()));
    const watched = child;
    if (watched !== null) {
      Effect.runFork(
        watchHost({
          probe: session().busy(),
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
  stopUpdaterBridge: () => stopUpdaterBridge(),
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
  const facts: HostFacts =
    replaced.length === 0
      ? hostFacts()
      : {
          ...hostFacts(),
          replacesHosts: replaced.map(({ pid, startedAt }) => ({
            pid,
            startedAt,
          })),
        };
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
      spawned = { pid: forked.pid, startedAt: Date.now() };
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
    if (isHostBeat(message)) state.lastBeat = { at: Date.now(), beat: message };
    beat.beat();
  });
  Effect.runFork(
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
          onFailed({ message, storeReport: null });
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
    const now = Date.now();
    crashes.push(now);
    while (crashes[0] !== undefined && crashes[0] < now - CRASH_WINDOW_MS) {
      crashes.shift();
    }
    if (crashes.length > CRASHES_ALLOWED) {
      onFailed({
        message: `The host stopped ${crashes.length} times in a minute.`,
        storeReport: null,
      });
      return;
    }
    // Only hosts that died within the crash window are vouched for: one
    // older may have left a group whose id is a stranger's by now.
    replaced = replaced.filter(
      (gone) => gone.exitedAt >= now - CRASH_WINDOW_MS,
    );
    if (spawned !== undefined) replaced.push({ ...spawned, exitedAt: now });
    restarts += 1;
    restartReason = state.stoppedFor ?? { kind: "exited", code };
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
      crashes.length = 0;
      if (!quitting) fork();
    });
  return restarting;
}

// The session with the current host, waiting for one to be up.
export function host(): ReturnType<typeof session> {
  return session();
}

// The host's runtime calls a window makes, for the nuke the shell runs
// with no window (electron/headlessNuke.ts).
export const hostRuntime = () => effectClient(runtimeContract, link());

// An exit with no quit sequence (that nuke's): the host closes its
// graph first, which stops what it runs (the tunnel's connector among
// them), and is not forked again.
export const letHostGo = (): Promise<void> => Effect.runPromise(stop(true));

// What the host is busy with, as a quit or an update asks: idle when
// it cannot say within a few seconds, since a host that does not
// answer has nothing to lose to them.
export const hostBusy = () =>
  busyWithin(session().busy(), BUSY_DEADLINE).pipe(
    Effect.map(Option.getOrElse(() => IDLE)),
  );

// The quit's own ask: a host that did not answer it is killed, not
// waited on to close.
let unanswered: UtilityProcess | null = null;
export const hostBusyForQuit = () =>
  Effect.suspend(() => {
    const asked = child;
    return busyWithin(session().busy(), BUSY_DEADLINE).pipe(
      Effect.tap((busy) =>
        Effect.sync(() => {
          unanswered = Option.isNone(busy) ? asked : null;
        }),
      ),
      Effect.map(Option.getOrElse(() => IDLE)),
    );
  });

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
  if (child !== null) tell(session().updaterState(state));
}

// Whether a window here is focused, kept to tell a host that forks
// later.
export function noteWindowFocused(focused: boolean): void {
  if (focused === windowFocused) return;
  windowFocused = focused;
  if (child !== null) tell(session().windowFocused(focused));
}

// A window here gained focus, told every time, also when focus moves
// from one of ours to another: the host reads the rows again for the
// window that comes back to them.
export function noteWindowGainedFocus(): void {
  windowFocused = true;
  if (child !== null) tell(session().windowFocused(true));
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
    if (unanswered === running) {
      running.kill();
      return Effect.promise(() => exited);
    }
    return session()
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
      registrar.serve(shellCallsContract, shellCalls);
      server = yield* makePortServer(registrar, ShellCallsGroup);
      yield* Effect.acquireRelease(Effect.sync(fork), () =>
        stop(options.hurried()),
      );
    }),
  );
