// Shared plumbing for the proofs: fixtures, teardown, sandboxes and the
// sm runner. The harness itself is vitest's.
import { execFileSync, spawn } from "node:child_process";
import { type AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { HandlerContext } from "../../shared/ipc/transport.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as TestClock from "effect/testing/TestClock";
import {
  GIT_IDENTITY,
  isolatedGitEnv,
  isolateGit,
} from "../../../test/gitIsolation.ts";
import { own, SYNC_SPAWN } from "../../../test/testProcesses.mts";

// The app root (app/ in the repo), resolved from this file's location
// under test/lib/.
const appRoot = join(import.meta.dirname, "..", "..");

// The repo root, one level up: where packages/ and file-sync/ live.
export const repoRoot = dirname(appRoot);

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

// process.env isolated (../../../test/gitIsolation.ts) with the locale pinned,
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
    execFileSync("git", args, { ...SYNC_SPAWN, cwd, env, encoding: "utf8" });
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

// The SHIGOMORI_* values a check's script run is given.
export const scriptEnv = {
  projectBranch: "main",
  defaultBranch: "main",
  title: "",
  description: "",
};

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
function cliFailureMessage(result: CliResult, fallback: string): string {
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

// The binary, in this process's group, ending with the case it ran in.
export function createCliRunner(
  binary: string,
  env: NodeJS.ProcessEnv,
): CliRunner {
  const runCli: RunCli = (args, onSpawn) =>
    new Promise((resolve, reject) => {
      const child = own(spawn(binary, ["--json", ...args], { env }));
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
