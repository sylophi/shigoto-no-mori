// Shared plumbing for the repo's check scripts. Scripts collect their
// own failure strings and hand them to `report` for the one epilogue
// shape every check prints.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CliDoc,
  CliResult,
  CliRunnerImpl,
} from "../../host/ipc/cliDelegate.ts";
import { errorMessageOf } from "../../shared/errors.ts";
import type { HandlerContext } from "../../shared/ipc/transport.ts";
import type { SupervisorClock } from "../../shared/remote/supervisor.ts";
import type { KeyValueStorage } from "../../web/lib/kvStorage.ts";

// The app root (app/ in the repo), resolved from this file's location
// under test/lib/.
export const appRoot = join(import.meta.dirname, "..", "..");

// The repo root, one level up: where cli/ and file-sync/ live.
export const repoRoot = dirname(appRoot);

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

// Strips block and line comments so prose can't trip source scans.
// Regex based, so a comment marker inside a string literal (a URL, a
// glob) mangles that string. Fine for presence checks, wrong for
// anything that needs faithful source.
export function stripComments(src: string): string {
  return src.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

// Recursively yields every file under `dir` whose name matches the
// `extensions` regex.
export function* walk(dir: string, extensions: RegExp): Generator<string> {
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile() && extensions.test(entry.name)) {
      yield join(entry.parentPath, entry.name);
    }
  }
}

// The port a listening TCP server (a net server, a ws server) bound.
export function boundPort(server: {
  address(): AddressInfo | string | null;
}): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server is not listening on a TCP port");
  }
  return address.port;
}

// A loopback port number nothing holds right now: bind an ephemeral
// listener and release it. Free the instant the close lands, and
// nothing else grabs an ephemeral port in the same tick.
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = boundPort(probe);
      probe.close(() => resolve(port));
    });
  });
}

export type Hold = <S extends Socket>(socket: S) => S;

export type LoopbackServer = {
  server: Server;
  port: number;
  connections(): number;
  close(): Promise<void>;
};

// A loopback test server, on an ephemeral port unless one is named,
// bound to `host` (127.0.0.1 unless named). `onConnection` is the
// per-socket behavior (echo, greet, close, proxy), handed the socket and
// `hold`, which puts a socket the check opened itself (a proxy's
// upstream) under the same teardown. `connections` counts accepted
// sockets so a grant proof can assert the handler never dialed.
export function startLoopbackServer(
  onConnection: (socket: Socket, hold: Hold) => void,
  { host = "127.0.0.1", port = 0 }: { host?: string; port?: number } = {},
): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    const state = { connections: 0 };
    const sockets = new Set<Socket>();
    const hold: Hold = (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      return socket;
    };
    const server = createServer((socket) => {
      state.connections += 1;
      hold(socket);
      // A host-side destroy can surface as ECONNRESET here, and an
      // unlistened socket error would take down the whole check.
      socket.on("error", () => {});
      onConnection(socket, hold);
    });
    // A named port can be taken: fail the check, not the process.
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({
        server,
        port: boundPort(server),
        connections: () => state.connections,
        close: () =>
          new Promise<void>((done) => {
            // server.close waits out live connections, and an assertion
            // failure reaches this finally with host-side conns still
            // open, so destroy accepted sockets or the process hangs
            // with no diagnostic instead of reporting the failure.
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

export type Checker = {
  check(label: string, fn: () => void): void;
  failures: string[];
};

// The failure-collecting harness every check script hand-rolls: a
// `failures` list and a `check(label, fn)` that runs one assertion group
// and records its message instead of throwing, so one failing group does
// not hide the rest. Returns both so the script can hand `failures` to
// `report` below. Synchronous, matching the assertion callbacks that use
// it.
export function makeChecker(): Checker {
  const failures: string[] = [];
  function check(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      failures.push(`${label}: ${errorMessageOf(error)}`);
    }
  }
  return { check, failures };
}

type Teardown = () => unknown;

export type Track = <T extends Teardown>(fn: T) => T;

export type Tracker = {
  track: Track;
  teardown(): Promise<void>;
};

// Teardown bookkeeping for fixture-heavy checks: register teardowns in
// creation order, run them in reverse, and keep going past a failing
// one so an assertion failure mid-scenario still releases every
// listener and socket instead of hanging the process (a cleanup
// failure never masks the test outcome). Used standalone by the checks
// whose scenarios share long-lived fixtures, and by makeProof's
// per-check cleanup below.
export function makeTracker(): Tracker {
  const teardowns: Teardown[] = [];
  return {
    track: (fn) => {
      teardowns.push(fn);
      return fn;
    },
    async teardown() {
      for (const fn of teardowns.toReversed()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- teardown is ordered
          await fn();
        } catch {
          // One failing teardown must not strand the rest.
        }
      }
    },
  };
}

// The polling pair every e2e check carries: a sleep, and a bounded
// wait on a predicate whose timeout names what it waited for.
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls a predicate, sync or async, until it holds.
// Whether a process is still there (signal 0 delivers nothing).
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(
  predicate: () => unknown,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await delay(25);
  }
}

// The global and system git config, cut off.
const GIT_CONFIG_CUT = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

// process.env with every GIT_* variable removed, for a check that runs
// git against a sandbox repository. The pre-commit hook exports
// GIT_DIR, GIT_INDEX_FILE and GIT_PREFIX for the REAL repository.
// Inherited, they point every sandbox command at the commit in
// progress (the sandbox commit then lands as the user's own, under the
// sandbox's message, which has happened). The global and system git
// config are also cut off so the host's identity and hooks never leak
// into the sandbox.
export function scrubbedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    ...GIT_CONFIG_CUT,
    LC_ALL: "C",
  };
}

// The same scrub applied to process.env itself, for a check whose code
// under test runs git in THIS process with process.env: every GIT_*
// deleted and the global and system config cut off, then `extra` on
// top (a locale pin, a fixture identity). Unlike scrubbedGitEnv it
// leaves the locale alone unless `extra` pins it.
export function scrubProcessGitEnv(extra: NodeJS.ProcessEnv = {}): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) delete process.env[key];
  }
  Object.assign(process.env, GIT_CONFIG_CUT, extra);
}

export type SandboxGit = (cwd: string, ...args: string[]) => string;

// git in a sandbox repository, under the scrubbed environment and a
// pinned identity, for the checks that build real repos. One copy, so a
// fix to how a sandbox is kept off the real repository reaches them all.
export function sandboxGit(
  gitEnv: NodeJS.ProcessEnv = scrubbedGitEnv(),
): SandboxGit {
  return (cwd, ...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=sm", "-c", "user.email=sm@example.test", ...args],
      { cwd, env: gitEnv, encoding: "utf8" },
    );
}

export type Proof = {
  check(label: string, fn: (track: Track) => unknown): Promise<void>;
  ok(label: string): void;
  done(): void;
  fail(error: unknown): void;
};

// The async sibling of makeChecker, for the e2e proof scripts: named
// scenario groups that drive real transports sequentially, where the
// first failure aborts the run. `name` is the proof phrase the summary
// lines print, like "sync-transfer proof".
//
//   - check(label, fn) awaits fn(track) and prints the "  ok" line.
//     track(cleanup) registers teardown on a per-check makeTracker, so
//     cleanups run in reverse order even when the assertions throw and
//     a failed check cannot leak the event loop.
//   - ok(label) records an assertion group the script ran inline, for
//     proofs whose scenarios share long-lived fixtures instead of
//     per-check setup.
//   - done() prints the "<name> OK (N assertions)" summary.
//   - fail(error) prints the FAILED epilogue and sets a nonzero exit
//     code, shaped for main().catch(fail).
export function makeProof(name: string): Proof {
  const passed: string[] = [];
  function ok(label: string): void {
    passed.push(label);
    console.log(`  ok  ${label}`);
  }
  async function check(
    label: string,
    fn: (track: Track) => unknown,
  ): Promise<void> {
    const { track, teardown } = makeTracker();
    try {
      await fn(track);
    } finally {
      await teardown();
    }
    ok(label);
  }
  return {
    check,
    ok,
    done: () => {
      console.log(`\n${name} OK (${passed.length} assertions)`);
    },
    fail: (error) => {
      console.error(`\n${name} FAILED: ${errorMessageOf(error)}`);
      process.exitCode = 1;
    },
  };
}

export type FakeClock = SupervisorClock & {
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
};

// A controllable SupervisorClock (shared/remote/supervisor.ts) for
// checks that drive supervised runners headlessly: timers fire when
// advance crosses them, and a settle tick lets promise chains complete
// before assertions.
export function fakeClock(): FakeClock {
  let time = 0;
  let nextTimerId = 1;
  const timers = new Map<unknown, { fn: () => void; at: number }>();
  return {
    now: () => time,
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      time += ms;
      // Deleting the visited entry is safe under Map iteration.
      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
  };
}

// The stand-in for a callback a stub only hands over later (a held
// dial's release, a child's exit observer): calling it before then
// fails the check instead of passing silently.
export function notYetSet(): never {
  assert.fail("a callback ran before the stub handed it over");
}

// The last entry of a list the check knows is non-empty (a ladder's
// top rung, the newest spawned child).
export function lastOf<T>(list: readonly T[]): T {
  const last = list.at(-1);
  assert.ok(last !== undefined, "expected a non-empty list");
  return last;
}

// The entry at `index` of a list the check knows reaches that far (a
// recorded call, a minted ticket, a ladder rung).
export function entryAt<T>(list: readonly T[], index: number): T {
  const entry = list[index];
  assert.ok(entry !== undefined, `expected an entry at ${index}`);
  return entry;
}

// What a handler gets from the wire when a check calls it directly: a
// live signal nobody aborts and a notifier that drops every frame.
// `overrides` supplies the caller, a frame sink, channels.
export function handlerCtx(
  overrides: Partial<HandlerContext> = {},
): HandlerContext {
  return {
    signal: new AbortController().signal,
    notifier: () => () => {},
    ...overrides,
  };
}

// `name` is the lowercase check phrase, like "host boundary". Failures
// print a capitalized header, each failure line, and the hint, then set
// a nonzero exit code. Setting exitCode instead of calling
// process.exit lets stderr flush when piped. Success prints "<name> OK".
export function report({
  name,
  failures,
  hint,
}: {
  name: string;
  failures: readonly string[];
  hint: string;
}): void {
  if (failures.length > 0) {
    console.error(
      `${name.charAt(0).toUpperCase()}${name.slice(1)} check failed:\n`,
    );
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n${hint}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${name} OK`);
}

// A fake Clerk session JWT whose payload carries the given sub,
// unsigned on purpose: deriveAccountId (shared/account/token.ts) never
// verifies, it only reads the account id. The device hub is the sole
// verifier. Shared by the account and web-bridge checks so the one
// stub token shape cannot drift between them.
const jwtSegment = (obj: object): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");

export function fakeSessionJwt(sub: string): string {
  return `${jwtSegment({ alg: "none", typ: "JWT" })}.${jwtSegment({ sub })}.sig`;
}

// A fresh temp dir named after `prefix`, resolved through realpath
// (macOS puts tmpdir behind a symlink, and git records the real path),
// that the check's tracker removes.
export function tempDir(prefix: string, track: Track): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  track(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A file's text, or null when it is not there, so an assert on it
// reports what was found instead of a bare false.
function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function fileEquals(path: string, want: string | null): boolean {
  return readOrNull(path) === want;
}

// The document-run seam the checks drive the sm CLI through: the same
// NDJSON protocol as the Electron runner (main/electron/cliRunner.ts),
// collecting every doc, the exit code and a stderr tail. `sm` throws
// on a non-zero exit with the CLI's own error doc as the message.
export function cliFailureMessage(result: CliResult, fallback: string): string {
  const error = result.docs.find(
    (doc) => doc.ok === false && typeof doc.error === "string",
  )?.error;
  return typeof error === "string"
    ? error
    : `${fallback} (CLI exit ${result.code})`;
}

// The kit runs under plain node as well as tsx, so the host's own
// splitter (host/lib/util/ndjson.ts) is not importable here. This is
// its standalone twin.
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    for (
      let newline = buffer.indexOf("\n");
      newline >= 0;
      newline = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") onLine(line);
    }
  };
}

type RunCli = CliRunnerImpl["runCli"];

export type CliRunner = {
  runCli: RunCli;
  sm(...args: string[]): Promise<CliResult>;
};

// The runner as the app's runs it (main/electron/cliRunner.ts): its
// own process group, and a cancel (opts.signal) that kills the group,
// so a proof can cut an `sm create` short mid-script the way a
// cancelled move does.
export function createCliRunner(
  binary: string,
  env: NodeJS.ProcessEnv,
): CliRunner {
  const runCli: RunCli = (args, onDoc, _extraEnv, opts) => {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ["--json", ...args], {
        env,
        detached: true,
      });
      const signal = opts?.signal;
      const onCancel = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      };
      if (signal?.aborted) onCancel();
      else signal?.addEventListener("abort", onCancel, { once: true });
      const docs: CliDoc[] = [];
      child.stdout.on(
        "data",
        lineSplitter((line) => {
          try {
            const doc: CliDoc = JSON.parse(line);
            docs.push(doc);
            onDoc?.(doc);
          } catch {
            // Non-JSON stdout line. The assertions read docs only.
          }
        }),
      );
      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onCancel);
        resolve({ code: code ?? -1, docs, stderrTail });
      });
    });
  };
  async function sm(...args: string[]): Promise<CliResult> {
    const result = await runCli(args);
    if (result.code !== 0) {
      throw new Error(
        `sm ${args.join(" ")} failed: ${cliFailureMessage(result, "no error doc")}\n${result.stderrTail}`,
      );
    }
    return result;
  }
  return { runCli, sm };
}

// An in-memory KeyValueStorage (web/lib/kvStorage.ts), standing in for
// window.localStorage in the checks that drive the web bridge headless.
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}
