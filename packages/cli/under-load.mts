// The at-a-terminal cases (test/cli.test.ts), each repeated, with busy
// loops beside them, round after round: what a Bun bump runs before it
// lands, since the menu's first key once went missing only under load
// (src/stdinFd.ts).
//   node under-load.mts [--rounds 8] [--repeats 60] [--busy 6]
import { spawn, spawnSync } from "node:child_process";
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
const stop = () => {
  for (const loop of busy) loop.kill("SIGKILL");
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

let failedRounds = 0;
for (let round = 1; round <= Number(values.rounds); round++) {
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/cli.test.ts", "-t", "at a terminal"],
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        CI: "true",
        SM_TERMINAL_REPEATS: values.repeats,
      },
      encoding: "utf8",
    },
  );
  const out = `${run.stdout}${run.stderr}`;
  const tests = /Tests\s+(.*)/.exec(out)?.[1]?.trim() ?? "no summary";
  if (run.status !== 0) {
    failedRounds++;
    process.stdout.write(out);
  }
  console.log(
    `round ${round}: ${run.status === 0 ? "ok" : "FAILED"}, ${tests}`,
  );
}
console.log(
  failedRounds === 0
    ? "every round passed"
    : `${failedRounds} of ${values.rounds} rounds failed`,
);
process.exitCode = failedRounds === 0 ? 0 : 1;
stop();
