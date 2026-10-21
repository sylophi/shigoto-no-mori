// The at-a-terminal cases (cli.test.ts), each repeated, with busy
// loops beside them, round after round: what a Bun bump runs before it
// lands, since Bun can lose a menu's first key under load
// (../src/stdinFd.ts).
//   node test/under-load.mts [--rounds 8] [--repeats 60] [--busy 6]
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "8" },
    repeats: { type: "string", default: "60" },
    busy: { type: "string", default: "6" },
  },
});

const busy = Array.from({ length: Number(values.busy) }, () =>
  spawn(process.execPath, ["-e", "for (;;);"], { stdio: "ignore" }),
);
// The round under way, in a process group of its own, so an interrupt
// ends vitest and the binaries it runs too.
let round: ChildProcess | null = null;
const stop = () => {
  for (const loop of busy) loop.kill("SIGKILL");
  if (round?.pid !== undefined) {
    try {
      process.kill(-round.pid, "SIGKILL");
    } catch {
      // The round has ended already.
    }
  }
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

// A round's output, and whether it passed.
const runRound = () =>
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    let out = "";
    round = spawn(
      "pnpm",
      ["exec", "vitest", "run", "test/cli.test.ts", "-t", "at a terminal"],
      {
        cwd: join(import.meta.dirname, ".."),
        env: {
          ...process.env,
          CI: "true",
          SM_TERMINAL_REPEATS: values.repeats,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    round.stdout?.on("data", (chunk: Buffer) => (out += chunk));
    round.stderr?.on("data", (chunk: Buffer) => (out += chunk));
    round.on("close", (code) => {
      round = null;
      resolve({ ok: code === 0, out });
    });
  });

let failedRounds = 0;
try {
  for (let at = 1; at <= Number(values.rounds); at++) {
    const { ok, out } = await runRound();
    const tests = /Tests\s+(.*)/.exec(out)?.[1]?.trim() ?? "no summary";
    if (!ok) {
      failedRounds++;
      process.stdout.write(out);
    }
    console.log(`round ${at}: ${ok ? "ok" : "FAILED"}, ${tests}`);
  }
} finally {
  stop();
}
console.log(
  failedRounds === 0
    ? "every round passed"
    : `${failedRounds} of ${values.rounds} rounds failed`,
);
process.exitCode = failedRounds === 0 ? 0 : 1;
