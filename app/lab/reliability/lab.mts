// The lab a run works in: the web client's dev server, a dev app on this
// machine as the host the web client reaches through the dev hub, and a
// Chrome profile of its own holding the web client's tabs, its network
// behind the switch. Everything a run starts it stops (Lab.close).
/* oxlint-disable no-await-in-loop -- the harness steps through time on purpose: each wait, poll and scenario follows the one before */
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  type WriteStream,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { NetworkSwitch } from "./networkSwitch.mts";

const appDir = resolve(import.meta.dirname, "../..");
export const repoDir = resolve(appDir, "..");

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

// The promise, or a failure naming `what` after `ms`: a page that stops
// answering must fail its check, not hang the run.
export function within<T>(
  ms: number,
  what: string,
  promise: Promise<T>,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_done, fail) =>
      setTimeout(
        () => fail(new Error(`${what} did not answer in ${ms} ms`)),
        ms,
      ),
    ),
  ]);
}

// Polls until `check` answers something truthy, or throws `what` once
// `ms` have gone by.
async function waitFor<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  ms: number,
  every = 250,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    let value: T | null | undefined | false = null;
    try {
      value = await check();
    } catch {
      // Not yet.
    }
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// One line of what a tab, the host or the harness said, for the trace.
export type TraceLine = {
  readonly at: number;
  readonly source: string;
  readonly level: string;
  readonly text: string;
};

// What the harness injects into every page: a visibility it controls
// (headless Chrome never hides a page), and each toast as a console
// line, so what reached the user is in the trace.
const PAGE_HOOKS = `(() => {
  let hidden = false;
  Object.defineProperty(Document.prototype, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(Document.prototype, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  window.harnessSetHidden = (next) => {
    hidden = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const toast of document.querySelectorAll("[data-sonner-toast]")) {
      if (seen.has(toast)) continue;
      seen.add(toast);
      console.info("[toast] " + (toast.textContent ?? "").trim());
    }
  }).observe(document, { childList: true, subtree: true });
})();`;

// What the harness reaches in a page besides window.api: its own hooks
// (PAGE_HOOKS), and the part of Clerk's global it uses.
declare global {
  interface Window {
    harnessSetHidden(hidden: boolean): void;
    Clerk?: {
      loaded?: boolean;
      session?: {
        getToken(options: { skipCache: boolean }): Promise<string | null>;
      } | null;
      client: {
        signIn: {
          create(options: object): Promise<{
            firstFactorVerification: {
              externalVerificationRedirectURL: URL | null;
            };
          }>;
        };
      };
    };
  }
}

export class Tab {
  readonly name: string;
  readonly page: Page;
  cdp: CDPSession | null = null;

  constructor(name: string, page: Page) {
    this.name = name;
    this.page = page;
  }

  async session(): Promise<CDPSession> {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    return this.cdp;
  }

  async setOffline(offline: boolean): Promise<void> {
    await (
      await this.session()
    ).send("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }

  async setHidden(hidden: boolean): Promise<void> {
    await this.page.evaluate((next) => window.harnessSetHidden(next), hidden);
  }

  // Stops the page's script in its tracks, timers, events and all, the
  // way a sleeping machine does. Chrome's own frozen lifecycle state
  // does not hold for a page it shows, and a headless one shows them
  // all, so the page is paused in the debugger instead.
  async setFrozen(frozen: boolean): Promise<void> {
    const session = await this.session();
    if (frozen) {
      await session.send("Debugger.enable");
      await session.send("Debugger.pause");
    } else {
      await session.send("Debugger.resume").catch(() => {});
      await session.send("Debugger.disable").catch(() => {});
    }
  }
}

export type HostFacts = {
  readonly deviceId: string;
  readonly label: string;
  readonly projectId: string;
  readonly projectName: string;
};

export type LabOptions = {
  readonly headed: boolean;
  readonly out: string;
  // Keep the host profile and the devices enrolled at the end, for the
  // next run.
  readonly keep: boolean;
};

export class Lab {
  readonly trace: TraceLine[] = [];
  readonly tabs: Tab[] = [];
  readonly tag = basename(repoDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 24);
  readonly profile = `${this.tag}-host`;
  readonly profileDir = join(homedir(), ".smd-profiles", this.profile);
  readonly browserDir = join(homedir(), ".smd-profiles", `${this.tag}-browser`);
  // The host's one project, named for the profile, so two labs on one
  // account never show a project of the same name.
  readonly hostRepo = join(this.profileDir, "repos", this.profile);
  readonly webPort = Number(portsEnv().WEB_PORT);
  readonly origin = `http://localhost:${this.webPort}`;
  readonly smd = join(appDir, "dist-cli", "smd");
  readonly hostLogFile = join(
    homedir(),
    "Library",
    "Logs",
    `Shigoto no Mori (Dev) [${this.profile}]`,
    "main.log",
  );
  host!: HostFacts;
  network!: NetworkSwitch;
  context!: BrowserContext;
  private hostDebugPort = 0;
  private hostLaunch: ChildProcess | null = null;
  private hostBrowser: Browser | null = null;
  private hostPage: Page | null = null;
  private webServer: ChildProcess | null = null;
  private readonly logs: WriteStream;
  private tabCount = 0;

  readonly options: LabOptions;

  constructor(options: LabOptions) {
    this.options = options;
    mkdirSync(options.out, { recursive: true });
    this.logs = createWriteStream(join(options.out, "processes.log"));
  }

  note(text: string, level = "info"): void {
    this.trace.push({ at: Date.now(), source: "harness", level, text });
    console.log(`[reliability] ${text}`);
  }

  // ---- the web client's dev server ----

  async startWeb(): Promise<void> {
    if (await answers(this.origin)) return;
    this.note(`starting the web client on ${this.origin}`);
    this.webServer = spawn("pnpm", ["web:dev"], {
      cwd: appDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.webServer.stdout?.pipe(this.logs, { end: false });
    this.webServer.stderr?.pipe(this.logs, { end: false });
    await waitFor("the web client", () => answers(this.origin), 60_000);
  }

  // ---- the host ----

  private hostEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SHIGOMORI_DATA_DIR: join(this.profileDir, "data"),
    };
  }

  smdJson<T>(args: string[]): T {
    return JSON.parse(
      execFileSync(this.smd, ["--json", ...args], {
        env: this.hostEnv(),
        cwd: this.hostRepo,
        encoding: "utf8",
      }),
    ) as T;
  }

  smdRun(args: string[]): void {
    execFileSync(this.smd, args, {
      env: this.hostEnv(),
      cwd: this.hostRepo,
      stdio: "ignore",
    });
  }

  // A repo for the host to list, made once per profile.
  private seedHost(): boolean {
    if (existsSync(join(this.profileDir, "data"))) return false;
    this.note(`seeding the host profile ${this.profile}`);
    const seed = join(this.profileDir, "seed");
    mkdirSync(join(this.profileDir, "repos"), { recursive: true });
    git(this.profileDir, "init", "-q", "-b", "main", seed);
    git(seed, "commit", "-q", "--allow-empty", "-m", "Initial");
    git(this.profileDir, "clone", "-q", seed, this.hostRepo);
    execFileSync(
      this.smd,
      ["projects", "add", join(this.profileDir, "repos"), "--all", "--yes"],
      { env: this.hostEnv(), stdio: "ignore" },
    );
    return true;
  }

  async startHost(): Promise<void> {
    if (!existsSync(this.smd)) {
      execFileSync(process.execPath, ["scripts/dev-cli.mts"], {
        cwd: appDir,
        stdio: "ignore",
      });
    }
    const fresh = this.seedHost();
    await this.launchHost(fresh);
    const facts = await this.hostEval(() =>
      Promise.all([window.api.account.status(), window.api.projects.list()]),
    );
    const [status, projects] = facts;
    const project = projects.find((p) => p.name === this.profile);
    if (project === undefined) throw new Error("the host lists no project");
    this.host = {
      deviceId: await this.hostEval(() => window.api.deviceId),
      label: status.deviceName,
      projectId: project.id,
      projectName: project.name,
    };
    this.note(`host ${this.host.label} is ${this.host.deviceId}`);
  }

  // Launches the dev app as the host profile and waits until it is
  // signed in, its hub socket connected and its tunnel up.
  async launchHost(cloneLogin: boolean): Promise<void> {
    this.hostDebugPort = await freePort();
    this.hostLaunch = spawn(
      "pnpm",
      ["device", this.profile, ...(cloneLogin ? ["--clone-login"] : [])],
      {
        cwd: appDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          SHIGOMORI_DEBUG_PORT: String(this.hostDebugPort),
          SM_ACCOUNT_WEB_ORIGIN: this.origin,
        },
      },
    );
    this.hostLaunch.stdout?.pipe(this.logs, { end: false });
    this.hostLaunch.stderr?.pipe(this.logs, { end: false });
    await this.attachHost();
  }

  async attachHost(): Promise<void> {
    this.hostBrowser = await waitFor(
      "the host window's debugging port",
      () => chromium.connectOverCDP(`http://127.0.0.1:${this.hostDebugPort}`),
      240_000,
      1000,
    );
    const page = await waitFor(
      "the host window",
      async () =>
        this.hostBrowser
          ?.contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url().startsWith("shigomori-dev://")),
      60_000,
    );
    this.hostPage = page;
    await waitFor(
      "the host to be signed in, on the hub, with its tunnel up",
      () =>
        page.evaluate(async () => {
          const [account, hub] = await Promise.all([
            window.api.account.status(),
            window.api.hub.status(),
          ]);
          return (
            account.signedIn &&
            hub.socket.phase === "connected" &&
            hub.tunnel === "up"
          );
        }),
      180_000,
      1000,
    );
  }

  async hostEval<T>(fn: () => T | Promise<T>): Promise<T> {
    const page = this.hostPage;
    if (page === null) throw new Error("no host window");
    return await page.evaluate(fn);
  }

  // The host's process (the shell's utility process for the profile),
  // which the shell forks again when it dies.
  hostPid(): number | null {
    const table = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
    });
    const line = table
      .split("\n")
      .find(
        (row) =>
          row.includes("node.mojom.NodeService") &&
          row.includes(`/profiles/${this.profile}`),
      );
    return line === undefined ? null : Number(line.trim().split(/\s+/)[0]);
  }

  // The whole dev app, the launcher and everything under it.
  async stopHostApp(): Promise<void> {
    await this.hostBrowser?.close().catch(() => {});
    this.hostBrowser = null;
    this.hostPage = null;
    const launch = this.hostLaunch;
    this.hostLaunch = null;
    if (launch?.pid === undefined) return;
    // Electron leaves the launcher's process group, so the whole tree
    // is signalled, found from the launcher down.
    const tree = processTree(launch.pid);
    for (const pid of tree) signal(pid, "SIGTERM");
    await waitFor(
      "the host app to quit",
      async () => tree.every((pid) => !alive(pid)),
      20_000,
    ).catch(() => {
      for (const pid of tree) signal(pid, "SIGKILL");
    });
    await waitFor(
      "the host app to exit",
      async () => this.hostPid() === null,
      30_000,
    );
    this.reapOrphans();
  }

  // The host's helpers that outlive a killed app: its cloudflared and
  // file-sync, once orphaned, from this checkout's builds.
  private reapOrphans(): void {
    const table = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    for (const row of table.split("\n")) {
      const [pid = "", ppid = "", ...command] = row.trim().split(/\s+/);
      const line = command.join(" ");
      const ours =
        line.startsWith(join(appDir, "dist-cloudflared", "cloudflared")) ||
        (line.startsWith(join(appDir, "dist-file-sync", "file-sync")) &&
          line.includes(this.profileDir));
      if (ours && ppid === "1") {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    }
  }

  // What the host itself says about the project's worktrees.
  hostBranches(): string[] {
    const rows = this.smdJson<Array<{ branch: string | null }>>([
      "worktrees",
      "list",
      "--identities",
    ]);
    return rows.map((row) => row.branch ?? "").toSorted();
  }

  hostLogSince(at: number): TraceLine[] {
    if (!existsSync(this.hostLogFile)) return [];
    const lines: TraceLine[] = [];
    for (const row of readFileSync(this.hostLogFile, "utf8").split("\n")) {
      const match =
        /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\] \[(\w+)\]\s+(.*)$/.exec(
          row,
        );
      if (match === null) continue;
      const lineAt = new Date(match[1]?.replace(" ", "T") ?? "").getTime();
      if (lineAt < at) continue;
      lines.push({
        at: lineAt,
        source: "host",
        level: match[2] ?? "info",
        text: match[3] ?? "",
      });
    }
    return lines;
  }

  // ---- the browser ----

  async startBrowser(): Promise<void> {
    this.network = await NetworkSwitch.start();
    mkdirSync(this.browserDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.browserDir, {
      channel: "chrome",
      headless: !this.options.headed,
      viewport: { width: 1440, height: 900 },
      proxy: {
        server: `http://127.0.0.1:${this.network.port}`,
        bypass: "localhost,127.0.0.1",
      },
    });
    await this.context.addInitScript(PAGE_HOOKS);
    for (const page of this.context.pages()) await page.close();
  }

  async openTab(): Promise<Tab> {
    const page = await this.context.newPage();
    const tab = new Tab(`tab${++this.tabCount}`, page);
    page.on("console", (message) => {
      const text = message.text();
      if (/React DevTools|development keys|\[vite\]/.test(text)) return;
      this.trace.push({
        at: Date.now(),
        source: tab.name,
        level: message.type(),
        text,
      });
    });
    page.on("pageerror", (error) => {
      this.trace.push({
        at: Date.now(),
        source: tab.name,
        level: "pageerror",
        text: error.stack ?? error.message,
      });
    });
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (url.includes("clerk-telemetry")) return;
      this.trace.push({
        at: Date.now(),
        source: tab.name,
        level: "requestfailed",
        text: `${request.method()} ${url.split("?")[0]} ${request.failure()?.errorText ?? ""}`,
      });
    });
    await page.goto(this.origin);
    this.tabs.push(tab);
    return tab;
  }

  async closeTab(tab: Tab): Promise<void> {
    await tab.page.close();
    this.tabs.splice(this.tabs.indexOf(tab), 1);
  }

  // Signs the browser profile in when it holds no Clerk session: by a
  // person in a headed run, or with the command in RELIABILITY_SIGN_IN,
  // which is handed GitHub's authorize URL for this tab's sign-in
  // attempt as $AUTH_URL and prints the URL GitHub sends it back to.
  async ensureSignedIn(tab: Tab): Promise<void> {
    const signedIn = () =>
      tab.page.evaluate(() => {
        const clerk = window.Clerk;
        return Boolean(clerk?.loaded && clerk.session);
      });
    await waitFor(
      "Clerk to load",
      () => tab.page.evaluate(() => Boolean(window.Clerk?.loaded)),
      120_000,
    );
    if (await signedIn()) return;
    const command = process.env.RELIABILITY_SIGN_IN;
    if (command !== undefined && command !== "") {
      this.note("signing the browser profile in (RELIABILITY_SIGN_IN)");
      const authUrl = await tab.page.evaluate(async () => {
        const clerk = window.Clerk;
        if (clerk === undefined) throw new Error("no Clerk on the page");
        const attempt = await clerk.client.signIn.create({
          strategy: "oauth_github",
          redirectUrl: `${location.origin}/`,
          actionCompleteRedirectUrl: `${location.origin}/`,
        });
        return String(
          attempt.firstFactorVerification.externalVerificationRedirectURL,
        );
      });
      const callback = execFileSync("sh", ["-c", command], {
        cwd: appDir,
        env: { ...process.env, AUTH_URL: authUrl },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      })
        .trim()
        .split("\n")
        .at(-1);
      if (callback === undefined || !callback.startsWith("https://")) {
        throw new Error("RELIABILITY_SIGN_IN printed no callback URL");
      }
      await tab.page.goto(callback);
    } else if (this.options.headed) {
      this.note("sign in with GitHub in the browser window");
    } else {
      throw new Error(
        "the browser profile is signed out: run once with --headed and sign in, or set RELIABILITY_SIGN_IN",
      );
    }
    await waitFor("the browser profile's sign-in", signedIn, 600_000, 1000);
  }

  async close(): Promise<void> {
    if (!this.options.keep) await this.revokeDevices();
    await this.context?.close().catch(() => {});
    await this.network?.stop().catch(() => {});
    await this.stopHostApp().catch(() => {});
    if (this.webServer?.pid !== undefined)
      killGroup(this.webServer.pid, "SIGTERM");
    if (!this.options.keep) {
      rmSync(this.profileDir, { recursive: true, force: true });
      rmSync(
        join(
          homedir(),
          "Library",
          "Application Support",
          "Shigoto no Mori (dev)",
          "profiles",
          this.profile,
        ),
        { recursive: true, force: true },
      );
    }
    this.logs.end();
  }

  // The web client's device and the host's, off the account. The browser
  // keeps its Clerk session, so the next run enrolls it again.
  private async revokeDevices(): Promise<void> {
    const tab = this.tabs[0];
    if (tab !== undefined) {
      await tab.page
        .evaluate(() => window.api.account.signOut())
        .catch(() => {});
    }
    if (this.hostPage !== null) {
      await this.hostEval(() => window.api.account.signOut()).catch(() => {});
    }
  }
}

// The process and every descendant, from the process table.
function processTree(root: number): number[] {
  const children = new Map<number, number[]>();
  const table = execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
  for (const row of table.split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || Number.isNaN(pid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) {
    tree.push(...(children.get(tree[i] ?? -1) ?? []));
  }
  return tree;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A commit's author and committer, whatever this machine's git config.
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lab",
      GIT_AUTHOR_EMAIL: "lab@example.com",
      GIT_COMMITTER_NAME: "lab",
      GIT_COMMITTER_EMAIL: "lab@example.com",
    },
    stdio: "ignore",
  });
}

function killGroup(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    // Already gone.
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

function portsEnv(): Record<string, string> {
  spawnSync(process.execPath, [join(appDir, "scripts", "ensure-ports.mts")], {
    cwd: appDir,
    stdio: "ignore",
  });
  const text = readFileSync(join(appDir, ".env.ports"), "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
}
