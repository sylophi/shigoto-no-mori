// The lab a run works in: a dev app on this machine as the host (B),
// and the clients that reach it, each behind a switch the harness
// throws (networkSwitch.mts):
//
// - web: the web client's dev server and a Chrome profile of its own
//   holding its tabs, reaching B through the dev hub over B's tunnel.
// - desktop: a second dev app (A), two windows, reaching B over the
//   LAN, its hub behind a front.
// - tunnel: a third (C), one window, dialing B's tunnel only
//   (SHIGOMORI_DIAL_KINDS=tunnel), as a device on another network does.
// - terminal: the terminal (`smd`) against A, whose cross-device verbs
//   ride A's link to B.
//
// Every client's link to B passes B's listener front, so the clients'
// network going down is the browser's proxy, the hub front and B's
// listener front going down together, while B itself stays online.
// Everything a run starts it stops (Lab.close).
/* oxlint-disable no-await-in-loop -- the harness steps through time on purpose: each wait, poll and scenario follows the one before */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { DevApp } from "./devApp.mts";
import {
  HubFront,
  ListenerFront,
  Network,
  NetworkSwitch,
} from "./networkSwitch.mts";
import {
  answers,
  appDir,
  envFile,
  freePort,
  git,
  killGroup,
  repoDir,
  waitFor,
  type TraceLine,
} from "./util.mts";

export { repoDir, sleep, within, type TraceLine } from "./util.mts";

export const CLIENT_KINDS = ["web", "desktop", "tunnel", "terminal"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

// What the harness injects into every page: a visibility it controls
// (headless Chrome never hides a page) and a wall-clock offset (a sleep
// longer than a token's life, without waiting for it), and each toast
// as a console line, so what reached the user is in the trace.
const PAGE_HOOKS = `(() => {
  if (window.harnessSetHidden !== undefined) return;
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
  const RealDate = Date;
  let offset = 0;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  window.Date = ShiftedDate;
  window.harnessShiftClock = (ms) => {
    offset += ms;
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
    harnessShiftClock(ms: number): void;
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

// A page a client shows: a browser tab, or a desktop app's window.
export class Tab {
  readonly name: string;
  readonly page: Page;
  // The app whose window it is, none for a browser tab.
  readonly app: DevApp | null;
  cdp: CDPSession | null = null;

  constructor(name: string, page: Page, app: DevApp | null) {
    this.name = name;
    this.page = page;
    this.app = app;
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

  // Moves the page's wall clock ahead, as a sleep does. Only ahead: a
  // clock that goes back is nothing a machine does, and Effect's
  // schedules read it. A reload puts it right.
  async advanceClock(ms: number): Promise<void> {
    await this.page.evaluate((offset) => window.harnessShiftClock(offset), ms);
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
  // Keep the profiles and the devices enrolled at the end, for the
  // next run.
  readonly keep: boolean;
  readonly clients: ReadonlySet<ClientKind>;
};

// A run of the terminal: what it printed, how it exited, how long it
// took.
export type TerminalRun = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
};

export class Lab {
  readonly trace: TraceLine[] = [];
  // The browser's tabs.
  readonly tabs: Tab[] = [];
  // The desktop apps' windows (A's, then C's).
  readonly windows: Tab[] = [];
  readonly tag = basename(repoDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 24);
  readonly profile = `${this.tag}-host`;
  readonly profileDir = join(homedir(), ".smd-profiles", this.profile);
  readonly browserDir = join(homedir(), ".smd-profiles", `${this.tag}-browser`);
  readonly webPort = Number(envFile(".env.ports").WEB_PORT);
  readonly origin = `http://localhost:${this.webPort}`;
  readonly smd = join(appDir, "dist-cli", "smd");
  readonly network = new Network();
  host!: HostFacts;
  // B, the host every client reaches.
  readonly hostApp: DevApp;
  // A, the desktop device under test, and C, the one on the tunnel.
  readonly desk: DevApp | null;
  readonly remote: DevApp | null;
  browserSwitch: NetworkSwitch | null = null;
  context!: BrowserContext;
  private hubFront: HubFront | null = null;
  private webServer: ChildProcess | null = null;
  private readonly logs: WriteStream;
  private tabCount = 0;
  private windowCount = new Map<DevApp, number>();

  readonly options: LabOptions;

  constructor(options: LabOptions) {
    this.options = options;
    mkdirSync(options.out, { recursive: true });
    this.logs = createWriteStream(join(options.out, "processes.log"));
    const app = (profile: string, needsTunnel: boolean) =>
      new DevApp({
        profile,
        repoName: this.profile,
        env: {},
        needsTunnel,
        logs: this.logs,
      });
    this.hostApp = app(this.profile, true);
    this.desk =
      this.has("desktop") || this.has("terminal")
        ? app(`${this.tag}-desk`, false)
        : null;
    this.remote = this.has("tunnel") ? app(`${this.tag}-tunnel`, false) : null;
  }

  has(kind: ClientKind): boolean {
    return this.options.clients.has(kind);
  }

  // Every page a client shows.
  pages(): Tab[] {
    return [...this.tabs, ...this.windows];
  }

  note(text: string, level = "info"): void {
    this.trace.push({ at: Date.now(), source: "harness", level, text });
    console.log(`[reliability] ${text}`);
  }

  // ---- the network ----

  // The fronts every client but the browser reaches B and the hub
  // through. The browser's switch comes with the browser.
  async startNetwork(): Promise<void> {
    const frontPort = await freePort();
    this.network.add(
      await ListenerFront.start(frontPort, async () =>
        this.hostApp.listenerPort(),
      ),
    );
    this.hostApp.options.env.SHIGOMORI_DIRECT_FRONT_PORT = String(frontPort);
    this.hostApp.options.env.SM_ACCOUNT_WEB_ORIGIN = this.origin;
    if (this.desk === null && this.remote === null) return;
    const hubUrl = envFile(".env.local").SM_DEVICE_HUB_URL;
    if (hubUrl === undefined)
      throw new Error("no SM_DEVICE_HUB_URL in .env.local");
    this.hubFront = this.network.add(await HubFront.start(hubUrl));
    for (const each of [this.desk, this.remote]) {
      if (each !== null) each.options.env.SM_DEVICE_HUB_URL = this.hubFront.url;
    }
    if (this.remote !== null) {
      this.remote.options.env.SHIGOMORI_DIAL_KINDS = "tunnel";
    }
    this.note(
      `B's listener front on ${frontPort}, the hub front on ${this.hubFront.port}`,
    );
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

  // ---- the devices ----

  smdJson<T>(args: string[], app: DevApp = this.hostApp): T {
    return JSON.parse(
      execFileSync(this.smd, ["--json", ...args], {
        env: app.smdEnv(),
        cwd: app.repo,
        encoding: "utf8",
      }),
    ) as T;
  }

  smdRun(args: string[], app: DevApp = this.hostApp): void {
    execFileSync(this.smd, args, {
      env: app.smdEnv(),
      cwd: app.repo,
      stdio: "ignore",
    });
  }

  // The terminal against A, with its exit, its words and its time, each
  // run a line in the trace. Never left running past `timeoutMs`.
  terminal(args: string[], timeoutMs = 90_000): Promise<TerminalRun> {
    const app = this.desk;
    if (app === null) throw new Error("the terminal needs the desktop device");
    const started = Date.now();
    return new Promise((done) => {
      const child = spawn(this.smd, args, {
        env: app.smdEnv(),
        cwd: app.repo,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        const said = (stderr.trim() || stdout.trim()).split("\n")[0] ?? "";
        this.trace.push({
          at: Date.now(),
          source: "term",
          level: code === 0 ? "info" : `exit-${code ?? "killed"}`,
          text: `smd ${args.join(" ")} (${ms} ms): ${said.slice(0, 240)}`,
        });
        done({ code, stdout, stderr, ms });
      });
    });
  }

  // A repo the devices share (matched by root commit), made once per
  // profile: B's from a seed, A's a clone of the same seed.
  private seed(app: DevApp, origin: string | null): boolean {
    if (existsSync(app.dataDir)) return false;
    this.note(`seeding the profile ${app.profile}`);
    mkdirSync(join(app.profileDir, "repos"), { recursive: true });
    let from = origin;
    if (from === null) {
      from = join(app.profileDir, "seed");
      git(app.profileDir, "init", "-q", "-b", "main", from);
      git(from, "commit", "-q", "--allow-empty", "-m", "Initial");
    }
    git(app.profileDir, "clone", "-q", from, app.repo);
    execFileSync(
      this.smd,
      ["projects", "add", join(app.profileDir, "repos"), "--all", "--yes"],
      { env: app.smdEnv(), stdio: "ignore" },
    );
    return true;
  }

  // Seeds and launches every device. A goes first when it runs: the
  // first window of a worktree is the primary, which serves the
  // renderer the others load, and B must be free to quit and relaunch.
  async startDevices(): Promise<void> {
    if (!existsSync(this.smd)) {
      execFileSync(process.execPath, ["scripts/dev-cli.mts"], {
        cwd: appDir,
        stdio: "ignore",
      });
    }
    const hostFresh = this.seed(this.hostApp, null);
    const origin = join(this.hostApp.profileDir, "seed");
    const deskFresh = this.desk !== null && this.seed(this.desk, origin);
    const remoteFresh = this.remote !== null && this.seed(this.remote, origin);
    if (this.desk !== null) {
      this.note(`launching A, ${this.desk.profile}`);
      await this.desk.launch(deskFresh);
    }
    this.note(`launching B, ${this.hostApp.profile}`);
    await this.hostApp.launch(hostFresh);
    if (this.remote !== null) {
      this.note(`launching C, ${this.remote.profile}`);
      await this.remote.launch(remoteFresh);
    }
    const [status, projects] = await this.hostApp.eval(() =>
      Promise.all([window.api.account.status(), window.api.projects.list()]),
    );
    const project = projects.find((p) => p.name === this.hostApp.profile);
    if (project === undefined) throw new Error("the host lists no project");
    this.host = {
      deviceId: await this.hostApp.eval(() => window.api.deviceId),
      label: status.deviceName,
      projectId: project.id,
      projectName: project.name,
    };
    this.note(`host ${this.host.label} is ${this.host.deviceId}`);
    if (this.desk !== null) {
      // A's sends and brings are commands B runs.
      await this.hostApp.eval(() =>
        window.api.account.setAcceptsCommands(true),
      );
      await this.adoptWindows(this.desk, "desk", this.has("desktop") ? 2 : 0);
    }
    if (this.remote !== null) await this.adoptWindows(this.remote, "tun", 1);
  }

  // Takes `count` of the app's windows as clients, opening more or
  // closing extras (a relaunch restores the windows a quit left).
  private async adoptWindows(
    app: DevApp,
    prefix: string,
    count: number,
  ): Promise<void> {
    const context = app.context();
    await context.addInitScript(PAGE_HOOKS);
    while (app.windows().length < Math.max(count, 1)) {
      const before = app.windows().length;
      await app.eval(() => window.api.window.open({ route: "/" }));
      await waitFor(
        `${app.profile}'s new window`,
        async () => app.windows().length > before,
        30_000,
      );
    }
    for (const extra of app.windows().slice(Math.max(count, 1))) {
      await extra.close().catch(() => {});
    }
    if (count === 0) return;
    for (const page of app.windows().slice(0, count)) {
      await this.adoptWindow(app, prefix, page);
    }
  }

  async adoptWindow(app: DevApp, prefix: string, page: Page): Promise<Tab> {
    const number = (this.windowCount.get(app) ?? 0) + 1;
    this.windowCount.set(app, number);
    const tab = new Tab(`${prefix}${number}`, page, app);
    this.listen(tab);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(PAGE_HOOKS);
    this.windows.push(tab);
    return tab;
  }

  // A new window of A's, as a client.
  async openWindow(app: DevApp, prefix: string): Promise<Tab> {
    const before = new Set(app.windows());
    await app.eval(() => window.api.window.open({ route: "/" }));
    const page = await waitFor(
      `${app.profile}'s new window`,
      async () => app.windows().find((each) => !before.has(each)),
      30_000,
    );
    return await this.adoptWindow(app, prefix, page);
  }

  async closeWindow(tab: Tab): Promise<void> {
    await tab.page.close();
    this.windows.splice(this.windows.indexOf(tab), 1);
  }

  // What every device logged since `at`, with B's lines as "host".
  devicesLogSince(at: number): TraceLine[] {
    return [
      ...this.hostApp.logSince(at, "host"),
      ...(this.desk?.logSince(at, "A") ?? []),
      ...(this.remote?.logSince(at, "C") ?? []),
    ];
  }

  // Kept for the scenarios written against the host alone.
  hostPid(): number | null {
    return this.hostApp.hostPid();
  }

  async stopHostApp(): Promise<void> {
    await this.hostApp.stop();
  }

  async launchHost(cloneLogin: boolean): Promise<void> {
    await this.hostApp.launch(cloneLogin);
  }

  async hostEval<T>(fn: () => T | Promise<T>): Promise<T> {
    return await this.hostApp.eval(fn);
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

  // ---- the browser ----

  async startBrowser(): Promise<void> {
    this.browserSwitch = this.network.add(await NetworkSwitch.start());
    mkdirSync(this.browserDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.browserDir, {
      channel: "chrome",
      headless: !this.options.headed,
      viewport: { width: 1440, height: 900 },
      proxy: {
        server: `http://127.0.0.1:${this.browserSwitch.port}`,
        bypass: "localhost,127.0.0.1",
      },
    });
    await this.context.addInitScript(PAGE_HOOKS);
    for (const page of this.context.pages()) await page.close();
  }

  private listen(tab: Tab): void {
    const { page } = tab;
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
  }

  async openTab(): Promise<Tab> {
    const page = await this.context.newPage();
    const tab = new Tab(`tab${++this.tabCount}`, page, null);
    this.listen(tab);
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
    const apps = [this.remote, this.desk, this.hostApp].filter(
      (each): each is DevApp => each !== null,
    );
    // Nothing may stay frozen, or it could not be revoked or quit.
    for (const app of apps) app.thaw(app.appPids());
    this.network.restore({ cut: true });
    if (!this.options.keep) {
      // The web client's device, and each app's. The browser keeps its
      // Clerk session, so the next run enrolls it again.
      const [tab] = this.tabs;
      await tab?.page
        .evaluate(() => window.api.account.signOut())
        .catch(() => {});
      for (const app of apps) await app.revoke();
    }
    await this.context?.close().catch(() => {});
    // B and C before A, whose launcher serves their renderer.
    for (const app of apps) await app.stop().catch(() => {});
    await this.network.stop().catch(() => {});
    if (this.webServer?.pid !== undefined) {
      killGroup(this.webServer.pid, "SIGTERM");
    }
    if (!this.options.keep) for (const app of apps) app.removeProfile();
    this.logs.end();
  }
}
