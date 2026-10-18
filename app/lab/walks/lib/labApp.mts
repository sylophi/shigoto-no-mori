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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { expect } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";

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
  readonly page: Page;
  // git in `cwd`, as the walk's own terminal would run it.
  git(cwd: string, ...args: string[]): string;
  // The bundle's terminal command on this lab's data folder.
  sm(...args: string[]): string;
  // Quits the app as a person does and starts it again on the same root.
  restart(): Promise<void>;
  // The app's processes: its main one first, then every helper it
  // started, each with its command line.
  pids(): { pid: number; command: string }[];
  // The app's host process (main/hostProcess.ts), the one Electron
  // utility process it forks that runs node.
  hostPid(): number;
  // The window the app shows now, once it has drawn: after the shell
  // put up a new one in place of one whose renderer went, `page` is it.
  followWindow(): Promise<Page>;
  close(): Promise<void>;
}

export interface LabOptions {
  // Makes the walk's repos under `reposDir`, before the app starts.
  readonly seed: (reposDir: string, git: Lab["git"]) => void;
  // The gh on the login shell's PATH, or one made in the walk's root.
  readonly gh?: string | ((root: string) => string);
  // The data folder reached through a symlink, as /tmp, /var/folders or
  // a folder linked to another drive put it.
  readonly linkedDataDir?: boolean;
}

// The walks remove the build's saved windows and, at the end, its whole
// footprint, which belongs to the lab build anyone on this machine runs:
// one that is already running is someone's, and a walk would also lose
// its single-instance lock to it.
export const refuseRunningLab = () => {
  const escaped = NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Any lab build's app, wherever its bundle is: they share one
  // footprint. Its helpers sit under Frameworks, not MacOS.
  const pattern = `${escaped}\\.app/Contents/MacOS/${escaped}`;
  let running = "";
  try {
    running = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  } catch {
    // pgrep exits 1 when nothing matches.
  }
  if (running.trim() !== "") {
    throw new Error(
      `A lab build is running (pid ${running.trim().split("\n").join(", ")}): quit it before the walks.`,
    );
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

export async function bootLab(options: LabOptions): Promise<Lab> {
  const bundle = labBundle();
  const executable = join(bundle, "Contents", "MacOS", NAME);
  refuseRunningLab();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-walk-")));
  try {
    return await launch(root, options, executable);
  } catch (cause) {
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
    symlinkSync(join(root, "actual"), join(root, "linked"));
  }
  const reposDir = join(root, "repos");
  for (const dir of [home, bin, reposDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(home, ".gitconfig"),
    `[user]\n\tname = ${WALK_AUTHOR.name}\n\temail = ${WALK_AUTHOR.email}\n[init]\n\tdefaultBranch = main\n`,
  );
  // The app rebuilds its environment from the login shell, after
  // path_helper has set PATH, so the fake gh goes in from the rc files.
  const rc = `export PATH="${bin}:$PATH"\nexport GH_CONFIG_DIR="${join(home, ".gh")}"\n`;
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
  };
  const git: Lab["git"] = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const sm: Lab["sm"] = (...args) =>
    execFileSync(labCli(), args, {
      env: { ...env, SHIGOMORI_DATA_DIR: dataDir },
      encoding: "utf8",
    });

  // The windows a previous walk left open would reopen on its pages.
  rmSync(
    join(
      userInfo().homedir,
      "Library",
      "Application Support",
      NAME,
      "windows.json",
    ),
    { force: true },
  );

  options.seed(reposDir, git);
  sm("projects", "add", reposDir, "--all", "--yes");

  const start = async () => {
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
    const run = { child, exited: false, browser: null as Browser | null };
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
      await waitFor(() => run.exited, "the lab app to quit", 10_000).catch(() =>
        child.kill("SIGKILL"),
      );
    };
    try {
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
      return { run, page, stop };
    } catch (cause) {
      await stop();
      throw cause;
    }
  };

  let current = await start();
  const close = async () => {
    await current.stop();
    // The app's own logs, kept for a look at a walk that failed in CI,
    // where its root goes with it: the shell's under the walk's home,
    // and the host's trace where Electron puts the logs folder, under
    // the account's real home, which the walks' nuke clears at the end.
    const keep = process.env["SM_WALK_LOGS"];
    if (keep !== undefined && keep !== "") {
      const walk = join(keep, basename(expect.getState().testPath ?? root));
      for (const [from, to] of [
        [join(home, "Library", "Logs"), walk],
        [join(userInfo().homedir, "Library", "Logs", NAME), join(walk, "host")],
      ] as const) {
        if (existsSync(from)) cpSync(from, to, { recursive: true });
      }
    }
    rmSync(root, { recursive: true, force: true });
  };
  const restart = async () => {
    await current.run.browser?.close().catch(() => {});
    // As the menu's Quit does, so the app saves what it keeps across a
    // start.
    execFileSync("osascript", [
      "-e",
      `tell application id "${BUNDLE_ID}" to quit`,
    ]);
    await waitFor(() => current.run.exited, "the lab app to quit", 20_000);
    current = await start();
  };
  return {
    root,
    home,
    dataDir,
    get page() {
      return current.page;
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
