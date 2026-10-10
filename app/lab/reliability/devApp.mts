// A dev app on this machine as a device of its own (a dev profile,
// ../dev-app.md): launched with `pnpm device`, driven over its windows'
// debugging port, killed, frozen and quit the ways a machine does, and
// read back through its logs. The lab's host is one, and so are the
// desktop device under test and the one that dials over the tunnel.
/* oxlint-disable no-await-in-loop -- the harness steps through time on purpose: each wait, poll and scenario follows the one before */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appDir, freePort, waitFor, type TraceLine } from "./util.mts";

export type DevAppOptions = {
  readonly profile: string;
  // What the app is launched with besides its debugging port.
  readonly env: NodeJS.ProcessEnv;
  // Whether it is up only with its own tunnel (a host a browser
  // reaches), or with the hub socket alone.
  readonly needsTunnel: boolean;
  readonly logs: WriteStream;
};

export class DevApp {
  readonly profile: string;
  readonly profileDir: string;
  readonly userDataDir: string;
  readonly logDir: string;
  readonly options: DevAppOptions;
  private debugPort = 0;
  private launched: ChildProcess | null = null;
  private browser: Browser | null = null;

  constructor(options: DevAppOptions) {
    this.options = options;
    this.profile = options.profile;
    this.profileDir = join(homedir(), ".smd-profiles", this.profile);
    this.userDataDir = join(
      homedir(),
      "Library",
      "Application Support",
      "Shigoto no Mori (dev)",
      "profiles",
      this.profile,
    );
    this.logDir = join(
      homedir(),
      "Library",
      "Logs",
      `Shigoto no Mori (Dev) [${this.profile}]`,
    );
  }

  // Its one project, named for the profile, so two labs on one account
  // never show a project of the same name. Every device's is a clone of
  // the host's seed, the same repo by its root commit.
  get repo(): string {
    return join(this.profileDir, "repos", this.profile);
  }

  get dataDir(): string {
    return join(this.profileDir, "data");
  }

  // The env `smd` runs in to act on this device's data dir.
  smdEnv(): NodeJS.ProcessEnv {
    return { ...process.env, SHIGOMORI_DATA_DIR: this.dataDir };
  }

  async launch(cloneLogin: boolean): Promise<void> {
    this.debugPort = await freePort();
    this.launched = spawn(
      "pnpm",
      ["device", this.profile, ...(cloneLogin ? ["--clone-login"] : [])],
      {
        cwd: appDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...this.options.env,
          SHIGOMORI_DEBUG_PORT: String(this.debugPort),
        },
      },
    );
    this.launched.stdout?.pipe(this.options.logs, { end: false });
    this.launched.stderr?.pipe(this.options.logs, { end: false });
    await this.attach();
  }

  // Attaches to the windows' debugging port and waits until the app is
  // signed in, on the hub, and (for a host) with its tunnel up.
  async attach(): Promise<void> {
    this.browser = await waitFor(
      `${this.profile}'s debugging port`,
      () => chromium.connectOverCDP(`http://127.0.0.1:${this.debugPort}`),
      240_000,
      1000,
    );
    const page = await waitFor(
      `${this.profile}'s window`,
      async () => this.windows()[0],
      60_000,
    );
    const needsTunnel = this.options.needsTunnel;
    await waitFor(
      `${this.profile} to be signed in and on the hub${needsTunnel ? ", with its tunnel up" : ""}`,
      () =>
        page.evaluate(async (tunnel) => {
          const [account, hub] = await Promise.all([
            window.api.account.status(),
            window.api.hub.status(),
          ]);
          return (
            account.signedIn &&
            hub.socket.phase === "connected" &&
            (!tunnel || hub.tunnel === "up")
          );
        }, needsTunnel),
      180_000,
      1000,
    );
  }

  // Its windows, in the order they opened.
  windows(): Page[] {
    return (this.browser?.contexts() ?? [])
      .flatMap((context) => context.pages())
      .filter((page) => page.url().startsWith("shigomori-dev://"));
  }

  context() {
    const context = this.browser?.contexts()[0];
    if (context === undefined)
      throw new Error(`${this.profile} is not attached`);
    return context;
  }

  async eval<T>(fn: () => T | Promise<T>): Promise<T> {
    const page = this.windows()[0];
    if (page === undefined) throw new Error(`no ${this.profile} window`);
    return await page.evaluate(fn);
  }

  // Its host (the shell's utility process for the profile), which the
  // shell forks again when it dies.
  hostPid(): number | null {
    const line = psTable("pid=,command=").find(
      (row) =>
        row.includes("node.mojom.NodeService") &&
        row.includes(`/profiles/${this.profile}`),
    );
    return line === undefined ? null : Number(line.trim().split(/\s+/)[0]);
  }

  // The port its direct listener is bound on (every interface, where
  // the loopback and port forwards bind 127.0.0.1), or null while none
  // is.
  listenerPort(): number | null {
    const pid = this.hostPid();
    if (pid === null) return null;
    let out = "";
    try {
      out = execFileSync(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
        { encoding: "utf8" },
      );
    } catch {
      return null;
    }
    const match = /\s\*:(\d+) \(LISTEN\)/.exec(out);
    return match === null ? null : Number(match[1]);
  }

  // Every process of the app: the Electron processes, which name the
  // profile's userData, and what they run (cloudflared, file-sync,
  // shells). Not the launcher, whose renderer server other apps of the
  // worktree load from.
  appPids(): number[] {
    const rows = psTable("pid=,ppid=,command=").map((row) => {
      const [pid = "", ppid = "", ...command] = row.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        command: command.join(" "),
      };
    });
    const ours = new Set(
      rows
        .filter(
          (row) =>
            row.command.includes(`/profiles/${this.profile}`) &&
            !row.command.includes("scripts/"),
        )
        .map((row) => row.pid),
    );
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (ours.has(row.ppid) && !ours.has(row.pid)) {
          ours.add(row.pid);
          grew = true;
        }
      }
    }
    return [...ours];
  }

  // The machine asleep: every process of the app stopped where it
  // stands, its sockets open and silent.
  freeze(): number[] {
    const pids = this.appPids();
    for (const pid of pids) signal(pid, "SIGSTOP");
    return pids;
  }

  thaw(pids: number[]): void {
    for (const pid of pids) signal(pid, "SIGCONT");
  }

  // The whole app, the launcher and everything under it.
  async stop(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    const launched = this.launched;
    this.launched = null;
    if (launched?.pid === undefined) return;
    // Electron leaves the launcher's process group, so the whole tree
    // is signalled, found from the launcher down.
    const tree = processTree(launched.pid);
    for (const pid of tree) signal(pid, "SIGTERM");
    await waitFor(
      `${this.profile} to quit`,
      async () => tree.every((pid) => !alive(pid)),
      20_000,
    ).catch(() => {
      for (const pid of tree) signal(pid, "SIGKILL");
    });
    await waitFor(
      `${this.profile} to exit`,
      async () => this.hostPid() === null,
      30_000,
    );
    this.reapOrphans();
  }

  // The app's helpers that outlive a killed app: its cloudflared and
  // file-sync, once orphaned, from this checkout's builds.
  private reapOrphans(): void {
    for (const row of psTable("pid=,ppid=,command=")) {
      const [pid = "", ppid = "", ...command] = row.trim().split(/\s+/);
      const line = command.join(" ");
      const ours =
        line.startsWith(join(appDir, "dist-cloudflared", "cloudflared")) ||
        (line.startsWith(join(appDir, "dist-file-sync", "file-sync")) &&
          line.includes(this.profileDir));
      if (ours && ppid === "1") signal(Number(pid), "SIGTERM");
    }
  }

  // Off the account. A cloned sign-in keeps the plain dev app's Clerk
  // session (dev-app.md, "Rules"), so this is the account layer's.
  async revoke(): Promise<void> {
    if (this.windows().length === 0) return;
    await this.eval(() => window.api.account.signOut()).catch(() => {});
  }

  removeProfile(): void {
    rmSync(this.profileDir, { recursive: true, force: true });
    rmSync(this.userDataDir, { recursive: true, force: true });
  }

  // What it logged since `at`: main.log (the shell's lines and the
  // host's, prefixed [host]), and every span the shell or the host
  // ended in failure, with its error, from their trace logs.
  logSince(at: number, source: string): TraceLine[] {
    const lines: TraceLine[] = [];
    const main = join(this.logDir, "main.log");
    if (existsSync(main)) {
      for (const row of tailOf(main).split("\n")) {
        const match =
          /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\] \[(\w+)\]\s+(.*)$/.exec(
            row,
          );
        if (match === null) continue;
        const lineAt = new Date(match[1]?.replace(" ", "T") ?? "").getTime();
        if (lineAt < at) continue;
        lines.push({
          at: lineAt,
          source,
          level: match[2] ?? "info",
          text: match[3] ?? "",
        });
      }
    }
    for (const file of ["trace.log", "host-trace.log"]) {
      const path = join(this.logDir, file);
      if (!existsSync(path)) continue;
      for (const row of tailOf(path).split("\n")) {
        // An interrupted span is a view or a call its caller let go.
        if (!row.includes('"outcome":"failed"')) continue;
        let span: {
          name?: string;
          start?: string;
          durationMs?: number;
          outcome?: string;
          attributes?: Record<string, unknown>;
          error?: unknown;
        };
        try {
          span = JSON.parse(row) as typeof span;
        } catch {
          continue;
        }
        const startAt = new Date(span.start ?? "").getTime();
        const endAt = startAt + (span.durationMs ?? 0);
        if (!(endAt >= at)) continue;
        lines.push({
          at: endAt,
          source,
          level: `span-${span.outcome ?? "?"}`,
          text: `${span.name ?? "?"} (${Math.round(span.durationMs ?? 0)} ms) ${JSON.stringify(span.error ?? span.attributes ?? {}).slice(0, 240)}`,
        });
      }
    }
    return lines;
  }
}

// The last few megabytes of a log, which hold any window a run reads.
function tailOf(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.length > 4_000_000 ? text.slice(-4_000_000) : text;
}

function psTable(format: string): string[] {
  return execFileSync("ps", ["-Ao", format], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
}

// The process and every descendant, from the process table.
function processTree(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const row of psTable("pid=,ppid=")) {
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
