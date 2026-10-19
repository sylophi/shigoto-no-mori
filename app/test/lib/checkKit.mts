// Shared plumbing for the proofs: fixtures, teardown, sandboxes and the
// sm runner. The harness itself is vitest's.
//
// covers: app/vitest.config.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { HandlerContext } from "../../shared/ipc/transport.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";
import type { KeyValueStorage } from "../../web/lib/kvStorage.ts";
import {
  GIT_IDENTITY,
  isolatedGitEnv,
  isolateGit,
} from "../../../gitIsolation.ts";

// The app root (app/ in the repo), resolved from this file's location
// under test/lib/.
export const appRoot = join(import.meta.dirname, "..", "..");

// The repo root, one level up: where packages/ and file-sync/ live.
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

type Teardown = () => unknown;

export type Track = <T extends Teardown>(fn: T) => T;

export type Tracker = {
  track: Track;
  teardown(): Promise<void>;
};

// Teardown bookkeeping for the proofs whose scenarios share long-lived
// fixtures (their afterAll runs `teardown`): register teardowns in
// creation order, run them in reverse, and keep going past a failing
// one so an assertion failure mid-scenario still releases every
// listener and socket instead of hanging the process (a cleanup
// failure never masks the test outcome).
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

// Whether a process is still there (signal 0 delivers nothing).
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Polls a predicate, sync or async, until it holds. The timeout names
// what it waited for. Loads vitest only once called, which keeps this
// module free of it for the scripts.
export async function waitFor(
  predicate: () => unknown,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const { vi } = await import("vitest");
  let threw = false;
  try {
    await vi.waitUntil(
      async () => {
        try {
          return await predicate();
        } catch (error) {
          threw = true;
          throw error;
        }
      },
      { timeout: timeoutMs, interval: 25 },
    );
  } catch (error) {
    // vi.waitUntil's own timeout names nothing.
    if (threw) throw error;
    throw new Error(`timed out waiting for ${what}`, { cause: error });
  }
}

// process.env isolated (../../../gitIsolation.ts) with the locale pinned,
// for a check that runs git against a sandbox repository.
export function scrubbedGitEnv(): NodeJS.ProcessEnv {
  return { ...isolatedGitEnv(), LC_ALL: "C" };
}

// The same isolation applied to process.env itself, for a check whose
// code under test runs git in THIS process with process.env, then
// `extra` on top (a locale pin, a fixture identity). Unlike
// scrubbedGitEnv it leaves the locale alone unless `extra` pins it.
export function scrubProcessGitEnv(extra: NodeJS.ProcessEnv = {}): void {
  isolateGit();
  Object.assign(process.env, extra);
}

export type SandboxGit = (cwd: string, ...args: string[]) => string;

// git in a sandbox repository, under the scrubbed environment and a
// pinned identity, for the checks that build real repos. One copy, so a
// fix to how a sandbox is kept off the real repository reaches them all.
export function sandboxGit(
  gitEnv: NodeJS.ProcessEnv = scrubbedGitEnv(),
): SandboxGit {
  const env = { ...GIT_IDENTITY, ...gitEnv };
  return (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

// A few turns of the event loop, for a reader to take a line and a
// writer to answer it.
export async function settleTurns(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// A TestClock for checks that drive supervised loops headlessly (the
// direct keeper, the supervisor): hand `context` to the loop, and
// `advance` moves the clock, runs whatever was due, then lets promise
// chains complete before assertions, as `settle` does on its own.
export function testClock() {
  const runtime = ManagedRuntime.make(TestClock.layer());
  const settle = settleTurns;
  return {
    context: runtime.runSync(Effect.context<never>()),
    now: () => runtime.runSync(Clock.currentTimeMillis),
    settle,
    advance: async (ms: number) => {
      await runtime.runPromise(TestClock.adjust(ms));
      await settle();
    },
  };
}

// A test clock as a process's clocks read it: `sleep` moves the wall
// clock and not the monotonic one, as a Mac's sleep does (and a clock
// step, either way); `stop` moves both while no timer runs, as a
// stopped process, or a hidden page's throttled timers, see them. The
// timers keep the test clock's own pace.
export function sleepingClock(clock: ReturnType<typeof testClock>) {
  const test = Context.get(clock.context, Clock.Clock);
  let slept = 0;
  let stopped = 0;
  const wall: Clock.Clock = {
    ...test,
    monotonicTimeNanosUnsafe: () =>
      test.monotonicTimeNanosUnsafe() + BigInt(stopped) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(
      () => test.monotonicTimeNanosUnsafe() + BigInt(stopped) * 1_000_000n,
    ),
    currentTimeMillisUnsafe: () => test.currentTimeMillisUnsafe() + slept,
    currentTimeMillis: Effect.sync(
      () => test.currentTimeMillisUnsafe() + slept,
    ),
    currentTimeNanosUnsafe: () =>
      test.currentTimeNanosUnsafe() + BigInt(slept) * 1_000_000n,
    currentTimeNanos: Effect.sync(
      () => test.currentTimeNanosUnsafe() + BigInt(slept) * 1_000_000n,
    ),
  };
  return {
    wall,
    sleep: (ms: number) => {
      slept += ms;
    },
    stop: (ms: number) => {
      slept += ms;
      stopped += ms;
    },
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
// connection nobody ends and a notifier that drops every frame.
// `overrides` supplies the caller, a frame sink, channels.
export function handlerCtx(
  overrides: Partial<HandlerContext> = {},
): HandlerContext {
  return {
    connection: new AbortController().signal,
    notifier: () => () => {},
    ...overrides,
  };
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

// A fake `gh` (`script`) first on PATH, with gh's config read from
// `config`, both put back as the test ends.
export function installFakeGh(
  root: string,
  script: string,
  track: Track,
  config = join(root, "gh-config"),
): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env["PATH"];
  const ghConfig = process.env["GH_CONFIG_DIR"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  process.env["GH_CONFIG_DIR"] = config;
  track(() => {
    process.env["PATH"] = path;
    if (ghConfig === undefined) delete process.env["GH_CONFIG_DIR"];
    else process.env["GH_CONFIG_DIR"] = ghConfig;
  });
}

// A file's text, or null when it is not there, so an assert on it
// reports what was found instead of a bare false.
function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function fileEquals(path: string, want: string | null): boolean {
  return readOrNull(path) === want;
}

// One NDJSON document the terminal sm printed with --json, and a run's
// documents, exit code and stderr tail.
interface CliDoc {
  event?: string;
  [key: string]: unknown;
}

export interface CliResult {
  code: number;
  docs: CliDoc[];
  stderrTail: string;
}

// How the checks drive the terminal sm: its --json documents, the exit
// code and a stderr tail. `sm` throws on a non-zero exit with the
// binary's own error doc as the message.
export function cliFailureMessage(result: CliResult, fallback: string): string {
  const error = result.docs.find(
    (doc) => doc.ok === false && typeof doc.error === "string",
  )?.error;
  return typeof error === "string"
    ? error
    : `${fallback} (CLI exit ${result.code})`;
}

type RunCli = (
  args: string[],
  // Hears the binary's pid as it starts, for a check that signals it.
  onSpawn?: (pid: number) => void,
) => Promise<CliResult>;

export type CliRunner = {
  runCli: RunCli;
  sm(...args: string[]): Promise<CliResult>;
};

// The binary in its own process group, so a group it signals is its own.
export function createCliRunner(
  binary: string,
  env: NodeJS.ProcessEnv,
): CliRunner {
  const runCli: RunCli = (args, onSpawn) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, ["--json", ...args], {
        env,
        detached: true,
      });
      if (child.pid !== undefined) onSpawn?.(child.pid);
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const docs: CliDoc[] = [];
        // An unterminated last line is no line.
        const lines = stdout.split("\n");
        lines.pop();
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            docs.push(JSON.parse(line.trim()));
          } catch {
            // Non-JSON stdout line. The assertions read docs only.
          }
        }
        resolve({ code: code ?? -1, docs, stderrTail });
      });
    });
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
