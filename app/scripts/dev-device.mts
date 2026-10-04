// One dev window as a device of its own, for weblab to start and
// attach to (lab/devices.md):
//
//   pnpm device <profile> [--fresh] [--clone-login]
//
// The window runs as the dev profile <profile> (scripts/lib/devProfile.mts)
// with Chromium's debugging port open on $PORT, the port weblab hands
// the command it starts (weblab attaches there, so it wins), else on
// SHIGOMORI_DEBUG_PORT.
// The first window of a worktree is the primary (`pnpm start`: the
// build, the renderer's vite server, deep links). A window launched
// while that vite server answers is a peer on the primary's build
// (scripts/dev-peer.mts), so a peer needs its primary running.
//
// PORT never reaches the app: there it would name the renderer's port,
// which .env.ports holds. SIGINT and SIGTERM go to the window's tree,
// which is how weblab stops it when the last session on it ends.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { errorMessageOf } from "../shared/errors.ts";
import { appRoot } from "./lib/appRoot.mts";
import { superviseChild } from "./lib/devBundle.mts";
import { devProfilePaths, parseDevProfileArgs } from "./lib/devProfile.mts";
import { rendererDevServerPort } from "./lib/portsEnvFile.mts";

const USAGE = "usage: pnpm device <profile> [--fresh] [--clone-login]";

function die(message: string): never {
  console.error(`[device] ${message}`);
  process.exit(1);
}

const [name, ...flags] = process.argv.slice(2);
if (name === undefined || name.startsWith("--")) die(USAGE);

const debugPort = process.env.PORT || process.env.SHIGOMORI_DEBUG_PORT;
delete process.env.PORT;
if (debugPort) process.env.SHIGOMORI_DEBUG_PORT = debugPort;

try {
  const args = parseDevProfileArgs(flags);
  if (args.profile !== null) die(`the name is positional here\n${USAGE}`);
  if (args.rest.length > 0) {
    die(`unknown arguments ${args.rest.join(" ")}\n${USAGE}`);
  }
  devProfilePaths(name);
} catch (error) {
  die(errorMessageOf(error));
}

const rendererPort = rendererDevServerPort();
const primaryRunning =
  rendererPort !== undefined &&
  (await fetch(`http://localhost:${rendererPort}`, {
    signal: AbortSignal.timeout(2000),
  }).then(
    () => true,
    () => false,
  ));

console.log(
  `[device] ${name} as the ${primaryRunning ? "peer" : "primary"}` +
    (debugPort ? `, debugging port ${debugPort}` : ""),
);
const child = primaryRunning
  ? spawn(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        join(appRoot, "scripts", "dev-peer.mts"),
        name,
        ...flags,
      ],
      { cwd: appRoot, stdio: "inherit" },
    )
  : spawn("pnpm", ["start", "--profile", name, ...flags], {
      cwd: appRoot,
      stdio: "inherit",
    });
superviseChild(child, primaryRunning ? "the peer" : "the primary");
