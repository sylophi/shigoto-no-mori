// Reconnect supervisor for one remote connection (v2 step 3, slice B,
// moved to shared/ in step 4 so the main-process relay socket reuses
// it). It is the SINGLE owner of retry for a connection: nothing else
// drives the connect function for it, so there is exactly one backoff
// ladder and one timer per connection, never a fan of overlapping
// reconnect loops.
//
// State machine, copying t3's discipline:
//   idle -> connecting -> connected -> backoff -> connecting -> ...
//                              \-> blocked (terminal until inputs change)
// A connection that STAYS OPEN past the stable threshold resets the
// ladder to the bottom, so a healthy link that blips once does not
// inherit a punishing delay. A blocking close (a wrong token on the LAN
// path, a revoked device on the relay path) goes to blocked with NO
// further retry: those failures must block rather than spin into a
// hammering loop. Every other close backs off.
//
// Deterministic on purpose: the ladder is fixed with no random jitter
// (the renderer runtime forbids Math.random anyway), and time is read
// through an injected clock so a test can advance it and assert the
// ladder and the reset without sleeping real seconds.
import {
  connectDevice,
  type ConnectDeviceOptions,
  type DeviceConnection,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import { CLOSE_AUTH_FAILED } from "@shared/ipc/socket/frames";

// Backoff delays in milliseconds, capped at the last rung. Fixed and
// jitter-free so a test asserts the exact sequence.
export const BACKOFF_LADDER_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

// A connection open at least this long before it drops is treated as
// healthy, so its next reconnect starts the ladder from the bottom.
export const STABLE_CONNECTION_MS = 30_000;

export type SupervisorStatus =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected"; remoteDeviceId: string; remoteAppVersion: string }
  | { phase: "backoff"; attempt: number; delayMs: number }
  | { phase: "blocked"; message: string }
  | { phase: "stopped" };

// Opaque timer handle: a number in the browser, a Timeout object under
// node. The supervisor only ever hands it back to clearTimeout.
export type SupervisorTimer = unknown;

// Injected time source. The default binds the platform globals, and
// tests pass a controllable clock to advance time and fire timers by
// hand.
export type SupervisorClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): SupervisorTimer;
  clearTimeout(timer: SupervisorTimer): void;
};

export const defaultSupervisorClock: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// The hello facts and target for one device, minus the callbacks the
// supervisor owns.
export type SupervisorParams = {
  url: string;
  token: string;
  appVersion: string;
  localDeviceId: string;
};

// The connect function, injectable so a test drives a stub instead of a
// real socket. Defaults to the real connectDevice.
export type ConnectFn = (
  opts: ConnectDeviceOptions,
) => Promise<DeviceConnection>;

// The block-vs-retry verdict for a close code, injectable because each
// wire has its own terminal codes. A non-null verdict blocks with its
// message. The default is the LAN rule: only a wrong token blocks.
// The relay connection supplies its own classifier for the revoked and
// superseded close codes.
export type CloseClassifier = (
  code: number | null,
) => { message: string } | null;

const AUTH_FAILED_MESSAGE = "authentication failed";

// Not exported: it is only the default classifier for this module. The
// relay path injects its own, and nothing else references it.
const lanCloseClassifier: CloseClassifier = (code) =>
  code === CLOSE_AUTH_FAILED ? { message: AUTH_FAILED_MESSAGE } : null;

export type SupervisorOptions = {
  params: SupervisorParams;
  connect?: ConnectFn;
  clock?: SupervisorClock;
  classifyClose?: CloseClassifier;
  // Status observer for a device registry / a live UI.
  onStatus?: (status: SupervisorStatus) => void;
  // The live connection on a successful handshake, and null the moment
  // it is lost or torn down, so the registry can build or drop the
  // per-device api against it.
  onConnection?: (connection: DeviceConnection | null) => void;
  helloTimeoutMs?: number;
};

export type Supervisor = {
  start(): void;
  stop(): void;
};

function backoffDelayMs(attempt: number): number {
  const index = Math.min(attempt, BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[index];
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const connect = options.connect ?? connectDevice;
  const clock = options.clock ?? defaultSupervisorClock;
  const classifyClose = options.classifyClose ?? lanCloseClassifier;

  let status: SupervisorStatus = { phase: "idle" };
  // True between start() and stop(). Guards every async continuation so
  // a connect resolving after stop() cannot revive a torn-down device.
  let running = false;
  // Ladder position for the current failure streak. Reset to 0 on a
  // stable disconnect, advanced on every scheduled backoff.
  let attempt = 0;
  let connection: DeviceConnection | null = null;
  // When the live connection opened, by the injected clock, so a close
  // can measure how long it stayed up.
  let connectedAt = 0;
  let retryTimer: SupervisorTimer | null = null;

  function setStatus(next: SupervisorStatus): void {
    status = next;
    options.onStatus?.(next);
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function block(message: string): void {
    // Terminal until inputs change: the owner drops and recreates the
    // supervisor when the url or token changes, which is what unblocks.
    connection = null;
    setStatus({ phase: "blocked", message });
  }

  function scheduleBackoff(resetLadder: boolean): void {
    // Clear any live retry first so this is the ONLY timer: the module
    // header promises exactly one backoff ladder, and two overlapping
    // schedules would fan into parallel connect attempts (C3).
    clearRetry();
    if (resetLadder) attempt = 0;
    const delayMs = backoffDelayMs(attempt);
    attempt += 1;
    setStatus({ phase: "backoff", attempt, delayMs });
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      if (running) attemptConnect();
    }, delayMs);
  }

  function handleClose(code: number | null): void {
    // Fires only for a socket that dropped on its own: the transport
    // suppresses this for an owner-initiated close.
    if (!running) return;
    connection = null;
    options.onConnection?.(null);
    const verdict = classifyClose(code);
    if (verdict !== null) {
      block(verdict.message);
      return;
    }
    const openMs = clock.now() - connectedAt;
    scheduleBackoff(openMs >= STABLE_CONNECTION_MS);
  }

  function onConnected(next: DeviceConnection): void {
    if (!running) {
      // Torn down while the handshake was in flight. Close the orphan so
      // it does not leak a live socket.
      next.close();
      return;
    }
    connection = next;
    connectedAt = clock.now();
    setStatus({
      phase: "connected",
      remoteDeviceId: next.remoteDeviceId,
      remoteAppVersion: next.remoteAppVersion,
    });
    options.onConnection?.(next);
  }

  function onConnectError(error: unknown): void {
    if (!running) return;
    // The transport tags a blocking close as blocked. Anything else
    // (hello timeout, host restart, network blip) is retryable, and a
    // failed attempt never counts as a stable connection.
    if (error instanceof RemoteConnectError && error.blocked) {
      block(classifyClose(error.code)?.message ?? AUTH_FAILED_MESSAGE);
      return;
    }
    scheduleBackoff(false);
  }

  function attemptConnect(): void {
    setStatus({ phase: "connecting" });
    connect({
      url: options.params.url,
      token: options.params.token,
      appVersion: options.params.appVersion,
      localDeviceId: options.params.localDeviceId,
      onClose: handleClose,
      helloTimeoutMs: options.helloTimeoutMs,
    })
      .then(onConnected)
      .catch(onConnectError);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      attempt = 0;
      attemptConnect();
    },
    stop(): void {
      if (!running && status.phase === "stopped") return;
      running = false;
      clearRetry();
      if (connection !== null) {
        connection.close();
        connection = null;
      }
      options.onConnection?.(null);
      setStatus({ phase: "stopped" });
    },
  };
}
