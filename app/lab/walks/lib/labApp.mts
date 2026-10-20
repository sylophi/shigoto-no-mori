// The packaged lab build, started for one walk: its own temp root with
// a home (a git identity, a fake gh first on the login shell's PATH and
// none of the user's shell hooks), a data folder, and the repos the
// walk seeds, registered through the bundle's own terminal command.
// The window is driven over its debugging port, as a person would
// click it.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";
import { devProfileNameSuffix } from "../../../shared/packaging/appName.mts";
import { onRunEnd, signalIfAlive } from "../../../../testProcesses.mts";
import { walkFailed } from "./failed.mts";

const APP_DIR = join(import.meta.dirname, "..", "..", "..");
const NAME = "Shigoto no Mori (lab)";
const BUNDLE_ID = "com.sylophi.shigomori.lab";

const labBundle = (): string => {
  const bundle =
    process.env["SM_LAB_APP"] ??
    join(APP_DIR, "out", `${NAME}-darwin-${process.arch}`, `${NAME}.app`);
  if (!existsSync(bundle)) {
    throw new Error(
      `No lab build at ${bundle}: build it with \`SM_FLAVOR=lab pnpm -C app package\`, or point SM_LAB_APP at one.`,
    );
  }
  return bundle;
};

export const labCli = (): string =>
  join(labBundle(), "Contents", "Resources", "smlab");

// A gh that is signed in nowhere, for walks that never reach GitHub.
const NO_GITHUB_GH = `#!/bin/sh
echo "You are not logged into any GitHub hosts." >&2
exit 1
`;

export const WALK_AUTHOR = { name: "Walk Tester", email: "walk@example.com" };

export interface Lab {
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  // The app's userData: the build's own, or the profile's under it.
  readonly userData: string;
  readonly page: Page;
  // The window's debugging port, for a weblab session to attach to a
  // walk held at a breakpoint.
  readonly debugPort: number;
  // git in `cwd`, as the walk's own terminal would run it.
  git(cwd: string, ...args: string[]): string;
  // The bundle's terminal command on this lab's data folder.
  sm(...args: string[]): string;
  // Quits the app as a person does and starts it again on the same root:
  // `between` runs once it has quit, and `atStart` has the new app's pid
  // before its window is waited for (a dialog it shows first). Not for a
  // walk's devices: the quit goes to every instance of the build.
  restart(options?: {
    readonly between?: () => void;
    readonly atStart?: (pid: number) => Promise<void>;
  }): Promise<void>;
  // The app's processes: its main one first, then every helper it
  // started, each with its command line.
  pids(): { pid: number; command: string }[];
  // The app's host process (main/hostProcess.ts), the one Electron
  // utility process it forks that runs node.
  hostPid(): number;
  // The window the app shows now, once it has drawn: after the shell
  // put up a new one in place of one whose renderer went, `page` is it.
  followWindow(): Promise<Page>;
  // The app the installer opened again once this one quit, which is no
  // child of the walk's, on the same debugging port: `page` is its window.
  followRelaunch(): Promise<Page>;
  close(): Promise<void>;
}

export interface LabOptions {
  // Makes the walk's repos under `reposDir`, before the app starts, and
  // what else of the user's they need in `home`.
  readonly seed: (reposDir: string, git: Lab["git"], home: string) => void;
  // The gh on the login shell's PATH, or one made in the walk's root.
  readonly gh?: string | ((root: string) => string);
  // The data folder reached through a symlink, as /tmp, /var/folders or
  // a folder linked to another drive put it.
  readonly linkedDataDir?: boolean;
  // A further device on this machine: its own userData, so its own
  // single-instance lock and hub credential (shared/packaging/appName.mts).
  readonly profile?: string;
  // More of the app's environment (a hub to enroll with, the update
  // stand-ins): at launch, and from the login shell's startup files too,
  // since the app rebuilds its environment from them and may read these
  // before or after.
  readonly env?: Readonly<Record<string, string>>;
  // Fills the data folder before the app's first start.
  readonly prepare?: (dataDir: string) => void;
}

// The walks remove the build's saved windows and, at the end, its whole
// footprint, which belongs to the lab build anyone on this machine runs:
// one that is already running is someone's, and a walk would also lose
// its single-instance lock to it.
export const refuseRunningLab = () => {
  const running = labRunning();
  if (running.length > 0) {
    throw new Error(
      `A lab build is running (pid ${running.join(", ")}): quit it before the walks.`,
    );
  }
};

// Any lab build's app, wherever its bundle is: they share one
// footprint. Its helpers sit under Frameworks, not MacOS.
function labRunning(): string[] {
  const escaped = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `${escaped}\\.app/Contents/MacOS/${escaped}`;
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((pid) => pid !== "");
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

// A Quit from the menu, to every lab app running. Bounded: a modal the
// app shows holds the Apple event's answer.
function quitByBundleId(): void {
  execFileSync(
    "osascript",
    ["-e", `tell application id "${BUNDLE_ID}" to quit`],
    {
      timeout: 10_000,
    },
  );
}

// The lab app listening on a loopback port, by its debugging port: a
// relaunched app's main process, and never a stranger's that took the
// port.
function labListenerOn(port: number): number | undefined {
  const pid = listenerOn(port);
  return pid !== undefined && labRunning().includes(String(pid))
    ? pid
    : undefined;
}

// The process listening on a loopback port.
function listenerOn(port: number): number | undefined {
  try {
    const pid = Number(
      execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")[0],
    );
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    // lsof exits 1 when nothing listens.
    return undefined;
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function appPids(app: number | undefined): { pid: number; command: string }[] {
  if (app === undefined) return [];
  const listed = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  const found = [{ pid: app, command: "" }];
  for (const line of listed.split("\n")) {
    const [pid, ppid, ...command] = line.trim().split(/\s+/);
    if (Number(ppid) === app) {
      found.push({ pid: Number(pid), command: command.join(" ") });
    }
  }
  return found;
}

// A failed walk's root (its repos, data folder and home with the
// shell's logs), with the host's trace beside it, kept under
// SM_WALK_FAILURES when it is set, with the newest KEPT_FAILURES of the
// runs before this one. Never inside a checkout: each root holds a copy
// of the repo, which the checkout's typecheck would read, gitignored or
// not. A keep or a prune that fails says so and never throws.
const KEPT_FAILURES = 5;
const KEPT_STAMP = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;
const stampOf = (date: Date) => date.toISOString().replace(/[:.]/g, "-");

// Where the app's host keeps its trace: a folder named for the app, whose
// name a profile adds to (shared/packaging/appName.mts).
const hostLogsOf = (profile: string | undefined) =>
  join(
    userInfo().homedir,
    "Library",
    "Logs",
    `${NAME}${profile === undefined ? "" : devProfileNameSuffix(profile)}`,
  );

function keepFailed(root: string, profile: string | undefined): void {
  const failures = process.env["SM_WALK_FAILURES"];
  if (failures === undefined || failures === "") return;
  const walk = basename(expect.getState().testPath ?? root);
  if (inCheckout(resolve(failures))) {
    console.error(
      `[walks] ${walk} failed; SM_WALK_FAILURES names a folder inside a checkout, so its root isn't kept`,
    );
    return;
  }
  const kept = join(
    failures,
    `${walk.replace(/\.walk\.mts$/, "")}${profile === undefined ? "" : `-${profile}`}-${stampOf(new Date())}`,
  );
  try {
    mkdirSync(failures, { recursive: true });
    cpSync(root, kept, { recursive: true, verbatimSymlinks: true });
    const host = hostLogsOf(profile);
    if (existsSync(host))
      cpSync(host, join(kept, "host-logs"), { recursive: true });
    console.error(`[walks] ${walk} failed: its root and logs are at ${kept}`);
  } catch (error) {
    console.error(
      `[walks] ${walk} failed, and keeping its root at ${kept} did too:`,
      error,
    );
  }
  try {
    pruneFailures(failures);
  } catch (error) {
    console.error(
      `[walks] pruning the kept roots in ${failures} failed:`,
      error,
    );
  }
}

// The roots kept by earlier runs past the newest few, by the stamp in
// their names: the folder may hold other folders, and this run's own
// roots all stay, its first failure the one that tells most.
function pruneFailures(failures: string): void {
  const runStart = stampOf(runStartedAt());
  const earlier = readdirSync(failures)
    .map((name) => ({ name, stamp: KEPT_STAMP.exec(name)?.[1] }))
    .filter(
      (entry): entry is { name: string; stamp: string } =>
        entry.stamp !== undefined && entry.stamp < runStart,
    )
    .toSorted((a, b) => b.stamp.localeCompare(a.stamp));
  for (const { name } of earlier.slice(KEPT_FAILURES)) {
    rmSync(join(failures, name), { recursive: true, force: true });
  }
}

// When this `pnpm walks` began: its test run folder's birth
// (testTemp.mts), which every walk file of the run shares.
const runStartedAt = (): Date => {
  const run = process.env["SM_TEST_RUN"];
  return run === undefined ? new Date() : statSync(run).birthtime;
};

// Whether `path`, or the nearest folder of it that exists, is inside a
// git checkout, this one or another (a `.git` folder or a worktree's
// `.git` file in it or above it).
function inCheckout(path: string): boolean {
  let at = path;
  while (!existsSync(at)) {
    const parent = dirname(at);
    if (parent === at) return false;
    at = parent;
  }
  for (let dir = realpathSync(at); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

export async function bootLab(options: LabOptions): Promise<Lab> {
  refuseRunningLab();
  return launchLab(options);
}

// bootLab without the refusal, for the devices of one walk, which run
// side by side as profiles once the walk has refused someone else's.
export async function launchLab(options: LabOptions): Promise<Lab> {
  const executable = join(labBundle(), "Contents", "MacOS", NAME);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-walk-")));
  try {
    return await launch(root, options, executable);
  } catch (cause) {
    keepFailed(root, options.profile);
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
}

async function launch(
  root: string,
  options: LabOptions,
  executable: string,
): Promise<Lab> {
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, options.linkedDataDir ? "linked" : "", "data");
  if (options.linkedDataDir) {
    mkdirSync(join(root, "actual"));
    symlinkSync("actual", join(root, "linked"));
  }
  const reposDir = join(root, "repos");
  for (const dir of [home, bin, reposDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(home, ".gitconfig"),
    `[user]\n\tname = ${WALK_AUTHOR.name}\n\temail = ${WALK_AUTHOR.email}\n[init]\n\tdefaultBranch = main\n`,
  );
  // The app rebuilds its environment from the login shell, after
  // path_helper has set PATH, so the fake gh goes in from the rc files.
  const rc = [
    `export PATH="${bin}:$PATH"`,
    `export GH_CONFIG_DIR="${join(home, ".gh")}"`,
    ...Object.entries(options.env ?? {}).map(
      ([key, value]) => `export ${key}="${value}"`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(home, ".zshrc"), rc);
  writeFileSync(join(home, ".bash_profile"), rc);
  const gh = options.gh ?? NO_GITHUB_GH;
  writeFileSync(join(bin, "gh"), typeof gh === "string" ? gh : gh(root));
  chmodSync(join(bin, "gh"), 0o755);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: home,
    TMPDIR: process.env["TMPDIR"],
    USER: process.env["USER"],
    LOGNAME: process.env["LOGNAME"],
    SHELL: process.env["SHELL"],
    GIT_CONFIG_NOSYSTEM: "1",
    ...(options.profile === undefined
      ? {}
      : { SHIGOMORI_PROFILE: options.profile }),
    ...options.env,
  };
  const git: Lab["git"] = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const sm: Lab["sm"] = (...args) =>
    execFileSync(labCli(), args, {
      env: { ...env, SHIGOMORI_DATA_DIR: dataDir },
      encoding: "utf8",
    });

  // The windows a previous walk left open would reopen on its pages.
  const buildUserData = join(
    userInfo().homedir,
    "Library",
    "Application Support",
    NAME,
  );
  const userData =
    options.profile === undefined
      ? buildUserData
      : join(buildUserData, "profiles", options.profile);
  rmSync(
    options.profile === undefined ? join(userData, "windows.json") : userData,
    { recursive: true, force: true },
  );

  // However the run ends (../../../../testProcesses.mts): every app this lab
  // started, the relaunched one included, and its folders.
  const started = new Set<number>();
  const removeFolders = () => {
    rmSync(root, { recursive: true, force: true });
    // A device's own folders, which the walks' nuke leaves: it clears the
    // build's, and a profile's are named for it.
    // Retried: a helper the app left can still be writing its last file.
    if (options.profile !== undefined) {
      for (const folder of [userData, hostLogsOf(options.profile)]) {
        rmSync(folder, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
    }
  };
  const forget = onRunEnd(() => {
    for (const pid of started) signalIfAlive(pid, "SIGKILL");
    removeFolders();
  });

  options.seed(reposDir, git, home);
  options.prepare?.(dataDir);
  if (readdirSync(reposDir).length > 0) {
    sm("projects", "add", reposDir, "--all", "--yes");
  }

  const start = async (atStart?: (pid: number) => Promise<void>) => {
    const port = await freeLoopbackPort();
    // --sm-lab hands the page api to the walks (labHandle.ts).
    const child = spawn(executable, ["--sm-lab"], {
      env: {
        ...env,
        SHIGOMORI_DATA_DIR: dataDir,
        SHIGOMORI_DEBUG_PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid !== undefined) started.add(child.pid);
    const run = {
      child,
      port,
      exited: false,
      browser: null as Browser | null,
    };
    child.once("exit", () => {
      run.exited = true;
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const stop = async () => {
      await run.browser?.close().catch(() => {});
      if (!run.exited) child.kill("SIGTERM");
      await waitFor(() => run.exited, "the lab app to quit", 10_000).catch(
        async () => {
          child.kill("SIGKILL");
          await waitFor(() => run.exited, "the lab app to die", 10_000).catch(
            () => {},
          );
        },
      );
    };
    try {
      if (child.pid !== undefined) await atStart?.(child.pid);
      await waitFor(
        async () => {
          if (run.exited) throw new Error(`the lab app exited: ${stderr}`);
          const targets = await fetch(`http://127.0.0.1:${port}/json`)
            .then((r) => r.json() as Promise<{ type: string }[]>)
            .catch(() => []);
          return targets.some((t) => t.type === "page");
        },
        "the lab app's window",
        60_000,
      );
      run.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = run.browser.contexts()[0]?.pages()[0];
      if (page === undefined) throw new Error("the lab app has no window");
      page.setDefaultTimeout(10_000);
      await page.waitForFunction(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
      );
      return { run, page, stop, port };
    } catch (cause) {
      await stop();
      throw cause;
    }
  };

  let current = await start();
  const close = async () => {
    await current.stop();
    // Every walk's logs, for CI's artifact: the shell's under the walk's
    // home, and the host's trace where Electron puts the logs folder,
    // under the account's real home, which the walks' nuke clears at the
    // end.
    // A copy that fails (a full disk) still lets the folders go.
    try {
      const keep = process.env["SM_WALK_LOGS"];
      if (keep !== undefined && keep !== "") {
        const walk = join(
          keep,
          basename(expect.getState().testPath ?? root),
          options.profile ?? "",
        );
        for (const [from, to] of [
          [join(home, "Library", "Logs"), walk],
          [hostLogsOf(options.profile), join(walk, "host")],
        ] as const) {
          if (existsSync(from)) cpSync(from, to, { recursive: true });
        }
      }
      if (walkFailed()) keepFailed(root, options.profile);
    } finally {
      removeFolders();
      forget();
    }
  };
  const restart: Lab["restart"] = async (hooks) => {
    await current.run.browser?.close().catch(() => {});
    // As the menu's Quit does, so the app saves what it keeps across a
    // start. One a dialog at its start quit is gone already.
    if (!current.run.exited) quitByBundleId();
    await waitFor(() => current.run.exited, "the lab app to quit", 20_000);
    hooks?.between?.();
    current = await start(hooks?.atStart);
  };
  return {
    root,
    home,
    dataDir,
    userData,
    get page() {
      return current.page;
    },
    get debugPort() {
      return current.port;
    },
    git,
    sm,
    restart,
    pids: () => appPids(current.run.child.pid),
    hostPid: () => {
      const host = appPids(current.run.child.pid).find(({ command }) =>
        command.includes("node.mojom.NodeService"),
      );
      if (host === undefined)
        throw new Error("the lab app has no host process");
      return host.pid;
    },
    followRelaunch: async () => {
      const { port } = current;
      await current.run.browser?.close().catch(() => {});
      // The app the installer opens again is the one listening on this
      // walk's port. From here on closing the lab stops it, however far
      // this gets: as the menu's Quit does where it is the only lab app
      // running (a quit by bundle id reaches every one), else by its pid,
      // and by SIGKILL past the quit's own bound.
      let relaunched: number | undefined;
      let browser: Browser | null = null;
      const stop = async () => {
        await browser?.close().catch(() => {});
        // One that comes up after the walk gave up on it is the walk's
        // too: no lab app ran before the walks (refuseRunningLab).
        if (relaunched === undefined) {
          await waitFor(
            () => {
              relaunched = labListenerOn(port);
              if (relaunched !== undefined) started.add(relaunched);
              return relaunched !== undefined;
            },
            "a late relaunch",
            30_000,
          ).catch(() => {});
        }
        const pid = relaunched;
        if (pid === undefined || !pidAlive(pid)) return;
        try {
          if (labRunning().length === 1) quitByBundleId();
          else process.kill(pid, "SIGTERM");
        } catch {
          // A quit that hung or failed: the kill below.
        }
        await waitFor(
          () => !pidAlive(pid),
          "the relaunched lab app to quit",
          20_000,
        ).catch(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Gone meanwhile.
          }
        });
      };
      current = { ...current, stop };
      await waitFor(() => current.run.exited, "the lab app to quit", 60_000);
      await waitFor(
        async () => {
          const targets = await fetch(`http://127.0.0.1:${port}/json`)
            .then((r) => r.json() as Promise<{ type: string }[]>)
            .catch(() => []);
          return targets.some((t) => t.type === "page");
        },
        "the relaunched app's window",
        90_000,
      );
      relaunched = labListenerOn(port);
      if (relaunched !== undefined) started.add(relaunched);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts()[0]?.pages()[0];
      if (page === undefined)
        throw new Error("the relaunched app has no window");
      page.setDefaultTimeout(10_000);
      await page.waitForFunction(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
      );
      current = { ...current, run: { ...current.run, browser }, page, stop };
      return page;
    },
    followWindow: async () => {
      const browser = current.run.browser;
      if (browser === null) throw new Error("the lab app has no browser");
      let drawn: Page | undefined;
      await waitFor(
        async () => {
          for (const page of browser.contexts()[0]?.pages() ?? []) {
            if (page.isClosed()) continue;
            const ok = await page
              .evaluate(
                () =>
                  (document.querySelector("#root")?.childElementCount ?? 0) > 0,
              )
              .catch(() => false);
            if (ok) drawn = page;
          }
          return drawn !== undefined;
        },
        "the lab app's window drawn again",
        30_000,
      );
      if (drawn === undefined) throw new Error("the lab app has no window");
      drawn.setDefaultTimeout(10_000);
      current.page = drawn;
      return drawn;
    },
    close,
  };
}
