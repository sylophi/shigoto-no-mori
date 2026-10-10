// What every part of the harness leans on: where things are, time, and
// the trace's line.
/* oxlint-disable no-await-in-loop -- polling steps through time on purpose */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";

export const appDir = resolve(import.meta.dirname, "../..");
export const repoDir = resolve(appDir, "..");

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

export function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

// The promise, or a failure naming `what` after `ms`: a page that stops
// answering must fail its check, not hang the run.
export function within<T>(
  ms: number,
  what: string,
  promise: Promise<T>,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_done, fail) =>
      setTimeout(
        () => fail(new Error(`${what} did not answer in ${ms} ms`)),
        ms,
      ),
    ),
  ]);
}

// Polls until `check` answers something truthy, or throws `what` once
// `ms` have gone by.
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  ms: number,
  every = 250,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    let value: T | null | undefined | false = null;
    try {
      value = await check();
    } catch {
      // Not yet.
    }
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// One line of what a client, a device or the harness said, for the
// trace.
export type TraceLine = {
  readonly at: number;
  readonly source: string;
  readonly level: string;
  readonly text: string;
};

// A commit's author and committer, whatever this machine's git config.
export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lab",
      GIT_AUTHOR_EMAIL: "lab@example.com",
      GIT_COMMITTER_NAME: "lab",
      GIT_COMMITTER_EMAIL: "lab@example.com",
    },
    stdio: "ignore",
  });
}

export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

export function killGroup(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    // Already gone.
  }
}

// This worktree's .env.ports, and a .env.local value the app reads.
export function envFile(
  name: ".env.ports" | ".env.local",
): Record<string, string> {
  if (name === ".env.ports") {
    spawnSync(process.execPath, [join(appDir, "scripts", "ensure-ports.mts")], {
      cwd: appDir,
      stdio: "ignore",
    });
  }
  const text = readFileSync(join(appDir, name), "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}
