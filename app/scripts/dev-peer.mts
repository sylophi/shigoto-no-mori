// A second dev app on this machine, as its own device: what
// `pnpm device <name> [--fresh] [--clone-login]` (dev-device.mts) runs
// once a primary is up. Runs the dev build the primary `pnpm start` made (its main bundle
// in .vite/build, which forge points at the primary's vite server) as
// the dev profile <name> (scripts/lib/devProfile.mts). It has no
// build of its own, so it needs the primary running, and it keeps the
// main-process code it booted with across a primary restart (which
// forge does only on `rs` typed in its terminal, never on its own).
// lab/devices.md covers the workflow around it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessageOf } from "../shared/errors.ts";
import {
  rendererDevServerAnswers,
  rendererDevServerUrl,
} from "./lib/portsEnvFile.mts";
import { appRoot } from "./lib/appRoot.mts";
import {
  devBundleExecutable,
  stockElectronExecutable,
  superviseChild,
} from "./lib/devBundle.mts";
import {
  applyDevProfileFlags,
  devProfileEnv,
  parsePositionalDevProfile,
} from "./lib/devProfile.mts";

function die(message: string): never {
  console.error(`[dev-peer] ${message}`);
  process.exit(1);
}

// A stale override (a leftover export, a nested dev shell) would
// resolve the stock Electron below to a foreign build, and must not
// reach the app either.
delete process.env.ELECTRON_OVERRIDE_DIST_PATH;

try {
  const { profile, args } = parsePositionalDevProfile(process.argv.slice(2));

  // The build must be the dev one forge made for the running vite
  // server: forge bakes that server's URL into it, so the bundle is
  // checked for the port port-pool gave this worktree (.env.ports,
  // the one vite.renderer.config.ts pins), and the server is probed.
  const build = join(appRoot, ".vite", "build", "index.js");
  if (!existsSync(build)) {
    die(
      "no dev build at .vite/build/index.js. Start the primary dev app first " +
        "(`pnpm start`): the peer runs from its build and its vite server.",
    );
  }
  const devServerUrl = rendererDevServerUrl();
  if (devServerUrl !== undefined) {
    if (!readFileSync(build, "utf8").includes(devServerUrl)) {
      die(
        `.vite/build/index.js was not built for the dev server at ${devServerUrl}` +
          " (a packaging run or a port change since). Restart `pnpm start`.",
      );
    }
    if (!(await rendererDevServerAnswers())) {
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
    [appRoot],
    { cwd: appRoot, stdio: "inherit", env },
  );
  superviseChild(child, "Electron");
} catch (error) {
  die(errorMessageOf(error));
}
