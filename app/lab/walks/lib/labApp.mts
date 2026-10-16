// The packaged lab build, started for one walk: its own temp root with
// a home (a git identity, a fake gh first on the login shell's PATH and
// none of the user's shell hooks), a data folder, and the repos the
// walk seeds, registered through the bundle's own terminal command.
// The window is driven over its debugging port, as a person would
// click it.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";

const APP_DIR = join(import.meta.dirname, "..", "..", "..");
const NAME = "Shigoto no Mori (lab)";

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
  close(): Promise<void>;
}

export interface LabOptions {
  // Makes the walk's repos under `reposDir`, before the app starts.
  readonly seed: (reposDir: string, git: Lab["git"]) => void;
  // The gh on the login shell's PATH, or one made in the walk's root.
  readonly gh?: string | ((root: string) => string);
}

export async function bootLab(options: LabOptions): Promise<Lab> {
  const bundle = labBundle();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-walk-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
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

  const port = await freeLoopbackPort();
  const child = spawn(join(bundle, "Contents", "MacOS", NAME), [], {
    env: {
      ...env,
      SHIGOMORI_DATA_DIR: dataDir,
      SHIGOMORI_DEBUG_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });

  let browser: Browser | null = null;
  const close = async () => {
    await browser?.close().catch(() => {});
    if (!exited) child.kill("SIGTERM");
    await waitFor(() => exited, "the lab app to quit", 10_000).catch(() =>
      child.kill("SIGKILL"),
    );
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await waitFor(
      async () => {
        if (exited) throw new Error(`the lab app exited: ${stderr}`);
        const targets = await fetch(`http://127.0.0.1:${port}/json`)
          .then((r) => r.json() as Promise<{ type: string }[]>)
          .catch(() => []);
        return targets.some((t) => t.type === "page");
      },
      "the lab app's window",
      60_000,
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (page === undefined) throw new Error("the lab app has no window");
    page.setDefaultTimeout(10_000);
    await page.waitForFunction(
      () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
    );
    return { root, home, dataDir, page, git, sm, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}
