// A second dev app on this machine, as its own device:
//
//   pnpm dev:peer <name> [--fresh] [--clone-login]
//
// Runs the dev build the primary `pnpm start` made (its main bundle
// in .vite/build, which forge points at the primary's vite server) as
// the dev profile <name> (scripts/lib/devProfile.mts). It has no
// build of its own, so it needs the primary running, and it keeps the
// main-process code it booted with when forge restarts the primary.
// MANUAL-TESTING.md covers the workflow around it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDotenv } from "../shared/account/serviceConfig.ts";
import { errorMessageOf } from "../shared/errors.ts";
import { repoRoot } from "./lib/checkKit.mjs";
import {
  devBundleExecutable,
  stockElectronExecutable,
  superviseChild,
} from "./lib/devBundle.mts";
import {
  applyDevProfileFlags,
  devProfileEnv,
  devProfilePaths,
  parseDevProfileArgs,
} from "./lib/devProfile.mts";

const USAGE = "usage: pnpm dev:peer <name> [--fresh] [--clone-login]";

function die(message: string): never {
  console.error(`[dev-peer] ${message}`);
  process.exit(1);
}

// A stale override (a leftover export, a nested dev shell) would
// resolve the stock Electron below to a foreign build, and must not
// reach the app either.
delete process.env.ELECTRON_OVERRIDE_DIST_PATH;

const [name, ...flags] = process.argv.slice(2);
if (name === undefined || name.startsWith("--")) die(USAGE);

try {
  const args = parseDevProfileArgs(flags);
  if (args.profile !== null) die(`the name is positional here\n${USAGE}`);
  if (args.rest.length > 0) {
    die(`unknown arguments ${args.rest.join(" ")}\n${USAGE}`);
  }
  const profile = devProfilePaths(name);

  // The build must be the dev one forge made for the running vite
  // server: forge bakes that server's URL into it, so the bundle is
  // checked for the port port-pool gave this worktree (.env.local,
  // the one vite.renderer.config.ts pins), and the server is probed.
  const build = join(repoRoot, ".vite", "build", "index.js");
  if (!existsSync(build)) {
    die(
      "no dev build at .vite/build/index.js. Start the primary dev app first " +
        "(`pnpm start`): the peer runs from its build and its vite server.",
    );
  }
  const port = readDotenvPort();
  if (port !== undefined) {
    const devServerUrl = `http://localhost:${port}`;
    if (!readFileSync(build, "utf8").includes(devServerUrl)) {
      die(
        `.vite/build/index.js was not built for the dev server at ${devServerUrl}` +
          " (a packaging run or a port change since). Restart `pnpm start`.",
      );
    }
    try {
      await fetch(devServerUrl, { signal: AbortSignal.timeout(2000) });
    } catch {
      die(
        `the renderer dev server at ${devServerUrl} does not answer. Is the ` +
          "primary dev app (`pnpm start`) running?",
      );
    }
  }

  applyDevProfileFlags(profile, args);

  const env = { ...process.env, ...devProfileEnv(profile) };
  // Would boot Electron as plain node.
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(
    `[dev-peer] profile ${profile.name}: data dir ${profile.dataDir}, userData ${profile.userData}`,
  );
  const child = spawn(
    devBundleExecutable() ?? stockElectronExecutable(),
    [repoRoot],
    { cwd: repoRoot, stdio: "inherit", env },
  );
  superviseChild(child, "Electron");
} catch (error) {
  die(errorMessageOf(error));
}

// The renderer port port-pool wrote for this worktree. Unset means
// vite picked its own, and there is nothing to check against.
function readDotenvPort(): string | undefined {
  try {
    return parseDotenv(readFileSync(join(repoRoot, ".env.local"), "utf8")).PORT;
  } catch {
    return undefined;
  }
}
