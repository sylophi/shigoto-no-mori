// A proof's children, each in a process group of its own, so a case
// that fails or runs out of time ends everything it started: after each
// case every group is SIGKILLed and checked gone (`reapGroups`), and
// `within` gives a case a deadline of its own below vitest's timeout.
import {
  type ChildProcess,
  spawn,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const started = new Set<ChildProcess>();

type Options = Omit<
  SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
  "stdio" | "detached"
>;

// Its stdin closed, its output piped.
export const spawnGroup = (
  command: string,
  args: readonly string[],
  options: Options,
) => {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  started.add(child);
  return child;
};

// The command's status and what it said.
export const runGroup = async (
  command: string,
  args: readonly string[],
  options: Options,
) => {
  const child = spawnGroup(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
};

const signal = (pgid: number, to: NodeJS.Signals | 0) => {
  try {
    process.kill(-pgid, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

export const reapGroups = async () => {
  const groups = [...started].flatMap((child) =>
    child.pid === undefined ? [] : [child.pid],
  );
  started.clear();
  for (const pgid of groups) signal(pgid, "SIGKILL");
  const left = () => groups.filter((pgid) => signal(pgid, 0));
  for (let tries = 0; left().length > 0 && tries < 100; tries++) {
    await sleep(50);
  }
  const survivors = left();
  if (survivors.length > 0) {
    throw new Error(
      `process groups still running after SIGKILL: ${survivors.join(", ")}`,
    );
  }
};

export const within = (ms: number, work: () => Promise<void>) => async () => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ran past its ${ms / 1000} s deadline`)),
      ms,
    );
  });
  try {
    await Promise.race([work(), late]);
  } finally {
    clearTimeout(timer);
  }
};
