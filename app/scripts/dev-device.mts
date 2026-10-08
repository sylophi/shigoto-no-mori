// One dev window as a device of its own, for weblab to start and
// attach to (lab/devices.md):
//
//   pnpm device <profile> [--fresh] [--clone-login]
//
// The window runs as the dev profile <profile> (scripts/lib/devProfile.mts)
// with Chromium's debugging port open on $PORT, the port weblab hands
// the command it starts (weblab attaches there, so it wins), else on
// SHIGOMORI_DEBUG_PORT. The first window of a worktree is the primary
// (`pnpm start`: the build, the renderer's vite server, deep links). A
// window launched while that vite server answers is a peer on the
// primary's build (scripts/dev-peer.mts). Without port-pool the
// renderer has no fixed port to probe, so every window starts as a
// primary. SIGINT and SIGTERM go to the window's tree, which is how
// weblab stops it when the last session on it ends.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { appRoot } from "./lib/appRoot.mts";
import { parsePositionalDevProfile } from "./lib/devProfile.mts";
import { descendantsIn } from "../host/lib/scripts/descendants.ts";
import { rendererDevServerAnswers } from "./lib/portsEnvFile.mts";

// The launch and everything under it: pnpm does not forward a signal
// to its children.
function signalPidTree(root: number, signal: NodeJS.Signals): void {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  }).stdout;
  for (const pid of [root, ...descendantsIn(table, root)]) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

const USAGE = "usage: pnpm device <profile> [--fresh] [--clone-login]";

const argv = process.argv.slice(2);
let profileName: string;
try {
  profileName = parsePositionalDevProfile(argv).profile.name;
} catch (error) {
  console.error(`[device] ${errorMessageOf(error)}\n${USAGE}`);
  process.exit(1);
}

const debugPort = process.env.PORT || process.env.SHIGOMORI_DEBUG_PORT;
if (debugPort) process.env.SHIGOMORI_DEBUG_PORT = debugPort;
// PORT stays out of the app's environment: the project scripts it runs
// inherit that, and many dev servers listen on PORT.
delete process.env.PORT;

// The probe below reads the renderer's port from .env.ports, which an
// older checkout may not hold yet (`pnpm start` runs this too).
spawnSync(process.execPath, [join(appRoot, "scripts", "ensure-ports.mts")], {
  cwd: appRoot,
  stdio: "inherit",
});

const asPeer = await rendererDevServerAnswers();
console.log(
  `[device] ${profileName} as the ${asPeer ? "peer" : "primary"}` +
    (debugPort ? `, debugging port ${debugPort}` : ""),
);
if (asPeer) {
  // Same process: dev-peer reads these arguments and supervises Electron.
  await import("./dev-peer.mts");
} else {
  // `pnpm start` is a shell chain, which passes no signal on to the
  // step that is running, so a stop goes to the whole tree under pnpm.
  // Windows cannot exec pnpm's .cmd shim without a shell.
  const child = spawn("pnpm", ["start", "--profile", ...argv], {
    cwd: appRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (child.pid !== undefined) signalPidTree(child.pid, signal);
    });
  }
  child.on("error", (error) => {
    console.error(`[device] failed to launch the primary: ${error}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    const stopped = signal === "SIGINT" || signal === "SIGTERM";
    process.exit(stopped ? 0 : (code ?? 1));
  });
}
