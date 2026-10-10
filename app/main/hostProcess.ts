// The shell's hold on its host: an Electron utility process
// (host/process/host.ts) it forks with its facts, serves calls back to
// over a port (packages/contracts/src/modules/shellCalls.ts), and talks
// to over the loopback like any device, through the session
// (modules/session.ts). A host that exits unasked is forked again, and
// told again what the shell knows; the windows' links redial it.
import { join } from "node:path";
import {
  app,
  MessageChannelMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { WebSocket as WsWebSocket } from "ws";
import { ShellCallsGroup } from "@shigomori/contracts/link";
import { sessionContract } from "@shigomori/contracts/modules/session";
import { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { buildClient } from "@shared/ipc/buildClient";
import { registerContract } from "@shared/ipc/registerContract";
import { log } from "@shared/log";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import { connectHost } from "@shared/remote/hostLink";
import { HOST_FACTS_FLAG, type HostFacts } from "@host/process/facts";
import { appPlace } from "./electron/appPlace";
import { noteMigration } from "./ipc/modules/migration";
import { relaunchAppUnattended } from "./electron/relaunch";
import { currentUpdaterState, updaterCalls } from "./electron/updater";
import { stopUpdaterBridge } from "./electron/updaterBridge";
import { setDeviceId } from "@host/lib/config/deviceId";
import { accountFactsForHost, retryParkedSignOut } from "./ipc/modules/account";
import { createShellRegistrar, makePortServer } from "./ipc/shellLink";

type Address = {
  readonly port: number;
  readonly token: string;
  readonly deviceId: string;
};

// A promise and its resolve, settled by whoever learns the value.
function deferred<A>(): { promise: Promise<A>; resolve: (value: A) => void } {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    rendererOrigin: rendererSchemeOrigin(app.isPackaged ? "prod" : "dev"),
  };
}

// A host that keeps dying is given up on, rather than forked in a loop.
const CRASH_WINDOW_MS = 60_000;
const CRASHES_ALLOWED = 3;
// How long a quit waits for the host to close its graph and exit.
const QUIT_DEADLINE_MS = 15_000;

let child: UtilityProcess | null = null;
let quitting = false;
let windowFocused = false;
let started = false;
const crashes: number[] = [];
// The current host's address, once it is up. Replaced as a host forks,
// so a window redialing meanwhile waits for the next one.
let address = deferred<Address>();
let onFailed: (failure: HostFailure) => void = () => {};

const session = () => buildClient(sessionContract, link);
let link: ReturnType<typeof connectHost>;

// A word to the host that nothing waits on. A host that went away
// meanwhile hears it again as its successor starts.
function tell(said: Promise<unknown>): void {
  void said.catch((error: unknown) => {
    log.warn("[host] could not tell the host:", error);
  });
}

// What the host asks of the shell.
const registrar = createShellRegistrar();
const shellCalls: Handlers<typeof shellCallsContract, HandlerContext> = {
  ready: (reported) => {
    // The device the host is, which the shell's account calls name.
    setDeviceId(reported.deviceId);
    address.resolve(reported);
    if (started) {
      link.reconnect();
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
  },
  failed: (failure) => onFailed(failure),
  migration: (progress) => noteMigration(progress),
  relaunch: () => relaunchAppUnattended(),
  updaterCheck: () => updaterCalls.check(),
  updaterInstall: ({ unattended }) => updaterCalls.install(unattended),
  updaterUpdate: ({ unattended }) => updaterCalls.update(unattended),
  stopUpdaterBridge: () => stopUpdaterBridge(),
};
registerContract(shellCallsContract, shellCalls, registrar, {
  validateOutputs: !app.isPackaged,
});
const server = Effect.runPromise(
  makePortServer(registrar, ShellCallsGroup).pipe(
    Scope.provide(Scope.makeUnsafe()),
  ),
);

function fork(): void {
  const { port1, port2 } = new MessageChannelMain();
  const forked = utilityProcess.fork(
    join(__dirname, "host.js"),
    [`${HOST_FACTS_FLAG}${JSON.stringify(hostFacts())}`],
    { serviceName: "Shigoto no Mori Host", stdio: "pipe" },
  );
  child = forked;
  // The host's console, into the shell's (and so its log file).
  for (const stream of [forked.stdout, forked.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line !== "") console.log(`[host] ${line}`);
      }
    });
  }
  void server.then((served) => Effect.runPromise(served.attach(port1, null)));
  forked.postMessage(null, [port2]);
  forked.once("exit", (code) => {
    child = null;
    if (quitting) return;
    log.warn(`[host] exited unasked (code ${code}), starting it again`);
    address = deferred<Address>();
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
    fork();
  });
}

// Forks the host, and dials it as it comes up. `failed` hears a host
// that could not start.
export function startHostProcess(options: {
  readonly failed: (failure: HostFailure) => void;
}): void {
  onFailed = options.failed;
  link = connectHost({
    address: () => address.promise,
    appVersion: app.getVersion(),
    // The `ws` package, like the host's own peer dials. It sends no
    // Origin, which the loopback admits.
    openSocket: (url) => new WsWebSocket(url),
  });
  fork();
}

// The session with the current host, waiting for one to be up.
export function host(): ReturnType<typeof session> {
  return session();
}

export function hostAddress(): Promise<Address> {
  return address.promise;
}

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

// Quit: the host closes its graph (its quit sequence) and exits. One
// that does not within the deadline is killed.
export async function stopHostProcess(hurried: boolean): Promise<void> {
  quitting = true;
  const running = child;
  if (running === null) return;
  const exited = new Promise<void>((resolve) =>
    running.once("exit", () => resolve()),
  );
  void session()
    .quit({ hurried })
    .catch((error: unknown) => {
      log.warn("[quit] the host did not take the quit:", error);
    });
  const timer = setTimeout(() => running.kill(), QUIT_DEADLINE_MS);
  await exited;
  clearTimeout(timer);
}
