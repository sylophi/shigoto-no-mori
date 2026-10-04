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
// primary's build (scripts/dev-peer.mts). SIGINT and SIGTERM go to the
// window's tree, which is how weblab stops it when the last session on
// it ends.
import { spawn } from "node:child_process";
import { errorMessageOf } from "../shared/errors.ts";
import { appRoot } from "./lib/appRoot.mts";
import { superviseChild } from "./lib/devBundle.mts";
import { parsePositionalDevProfile } from "./lib/devProfile.mts";
import { rendererDevServerAnswers } from "./lib/portsEnvFile.mts";

const USAGE = "usage: pnpm device <profile> [--fresh] [--clone-login]";

const argv = process.argv.slice(2);
try {
  parsePositionalDevProfile(argv);
} catch (error) {
  console.error(`[device] ${errorMessageOf(error)}\n${USAGE}`);
  process.exit(1);
}

const debugPort = process.env.PORT || process.env.SHIGOMORI_DEBUG_PORT;
if (debugPort) process.env.SHIGOMORI_DEBUG_PORT = debugPort;
// PORT stays out of the app's environment: the project scripts it runs
// inherit that, and many dev servers listen on PORT.
delete process.env.PORT;

const asPeer = await rendererDevServerAnswers();
console.log(
  `[device] ${argv[0]} as the ${asPeer ? "peer" : "primary"}` +
    (debugPort ? `, debugging port ${debugPort}` : ""),
);
if (asPeer) {
  // Same process: dev-peer reads these arguments and supervises Electron.
  await import("./dev-peer.mts");
} else {
  const [name, ...flags] = argv;
  superviseChild(
    spawn("pnpm", ["start", "--profile", name ?? "", ...flags], {
      cwd: appRoot,
      stdio: "inherit",
    }),
    "the primary",
  );
}
