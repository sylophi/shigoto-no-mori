// The guide's how-tos: twenty questions a new user asks, each run
// headless through Claude Code and Codex against a dev app on this
// machine, on a session the app launched the way its Help menu's item
// does, the question typed as the person would. A tour passes when
// the window shows the guide pointing at the control that answers the
// question. README.md has what it reports.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { guideCommand } from "@shigomori/engine/agentGuide";
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import type { Page } from "playwright-core";
import { onRunEnd } from "../../../testProcesses.mts";
import { DevApp } from "../reliability/devApp.mts";
import { pageApi, withPageApi } from "../reliability/pageApi.mts";
import { isolateGit } from "../../../gitIsolation.ts";
import { appDir, git, repoDir, sleep, waitFor } from "../reliability/util.mts";

// The fixture repository's git, the app's and the agents' off this
// repository and this machine's config (../../../gitIsolation.ts).
isolateGit();

type Harness = "claude" | "codex";

type HowTo = {
  readonly question: string;
  // What a pointed-at control is called (its accessible name or text)
  // when it answers the question.
  readonly point: RegExp;
};

const HOW_TOS: readonly HowTo[] = [
  {
    question: "How do I rename a worktree's folder?",
    // The pencil is named for the folder it renames.
    point: /^Rename (?!branch)|Folder name/i,
  },
  { question: "How do I rename a branch?", point: /Rename branch/i },
  {
    question: "How do I make a new worktree?",
    point: /Quick-create worktree|New worktree/i,
  },
  { question: "How do I add another project?", point: /Add project/i },
  { question: "How do I add a port to a worktree?", point: /Add port/i },
  { question: "How do I open a terminal in a worktree?", point: /Terminal/ },
  {
    question: "Where do I see a worktree's uncommitted changes?",
    point: /Changes|uncommitted/i,
  },
  {
    question: "How do I change the key that opens the terminal?",
    point: /Keyboard|Toggle the terminal|Ctrl/i,
  },
  {
    question: "How do I switch to dark mode?",
    point: /Dark|Theme|Appearance/i,
  },
  { question: "How do I turn off village life?", point: /Village life/i },
  { question: "How do I delete a worktree?", point: /Delete worktree/i },
  {
    question: "Where do I see everything that's running on this machine?",
    point: /^Live/i,
  },
  {
    question: "How do I open a worktree in my editor?",
    point: /Zed|Xcode|Vim|Launch/i,
  },
  {
    question: "How do I set a setup script for a project?",
    point: /setup|Configure/i,
  },
  { question: "How do I change the order of the sidebar?", point: /Sort/i },
  {
    question: "How do I switch a worktree to another branch?",
    point: /Switch branch/i,
  },
  {
    question: "How do I copy a worktree's branch name?",
    point: /Copy branch name/i,
  },
  {
    question: "How do I mirror this worktree to my other Mac?",
    point: /Mirror|Devices|Sign in|Options/i,
  },
  {
    question: "How do I turn off sharing with my other devices?",
    // Signed out, nothing is shared: the way there is to sign in.
    point: /Share with other devices|Sign in|account/i,
  },
  {
    question: "How do I sign in to link my devices?",
    point: /Sign in|Account|Devices/i,
  },
];

const { values: flags } = parseArgs({
  options: {
    harness: { type: "string", multiple: true },
    only: { type: "string" },
    tag: { type: "string", default: basename(repoDir) },
  },
});
const harnesses = (flags.harness ?? ["claude", "codex"]) as Harness[];
const only = flags.only?.split(",").map(Number);
const howTos = HOW_TOS.filter(
  (_, i) => only === undefined || only.includes(i + 1),
);
const profile = `${flags.tag}-guide-eval`;
const out = join(import.meta.dirname, "report");
mkdirSync(out, { recursive: true });
const logs = createWriteStream(join(out, "app.log"));

const smd = join(appDir, "dist-cli", "smd");
const TOUR_LIMIT_MS = 300_000;

// A fresh profile with one project of one commit, seeded before the app
// starts, so it opens on the project and not on the empty home.
const app = new DevApp({
  profile,
  repoName: "forest-demo",
  env: {},
  needsTunnel: false,
  signedOut: true,
  logs,
});
rmSync(app.profileDir, { recursive: true, force: true });
rmSync(app.logDir, { recursive: true, force: true });
mkdirSync(app.repo, { recursive: true });
git(app.repo, "init", "-q", "-b", "main");
git(app.repo, "commit", "-q", "--allow-empty", "-m", "Initial");
execFileSync(smd, ["projects", "add", app.repo], { env: app.smdEnv() });
// And a worktree besides the primary checkout, which a folder rename needs.
execFileSync(smd, ["worktrees", "create", "--no-cd"], {
  cwd: app.repo,
  env: app.smdEnv(),
});
const guideFolder = join(app.dataDir, "guide");

const terminalWasRunning = running("Terminal");

function running(name: string): boolean {
  try {
    execFileSync("pgrep", ["-x", name]);
    return true;
  } catch {
    return false;
  }
}

// When each of the shell's guide actions began, from its trace, read
// as it grows.
const drives: { at: number; action: string }[] = [];
let traceRead = 0;
let traceRest = "";
function driveStarts(since: number): { at: number; action: string }[] {
  try {
    const fd = openSync(join(app.logDir, "trace.log"), "r");
    const size = fstatSync(fd).size;
    if (size > traceRead) {
      const chunk = Buffer.alloc(size - traceRead);
      readSync(fd, chunk, 0, chunk.length, traceRead);
      traceRead = size;
      const lines = (traceRest + chunk.toString()).split("\n");
      traceRest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"Guide.drive"')) continue;
        const span = JSON.parse(line) as {
          start: string;
          attributes?: { action?: string };
        };
        drives.push({
          at: Date.parse(span.start),
          action: span.attributes?.action ?? "",
        });
      }
    }
    closeSync(fd);
  } catch {
    // No trace yet.
  }
  return drives.filter((span) => span.at >= since);
}

// What the guide points at in the window now, by name.
const pointedAt = (page: Page) =>
  page.evaluate(() => {
    const target = document.querySelector("[data-guide-target]");
    if (target === null) return null;
    // Its accessible name: its label, the text of what labels it (by id
    // or a <label for>), or its own text.
    const labelledBy = target
      .getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const labels = (target as HTMLInputElement).labels;
    const name =
      target.getAttribute("aria-label") ??
      labelledBy ??
      (labels !== null && labels !== undefined && labels.length > 0
        ? [...labels].map((label) => label.textContent ?? "").join(" ")
        : (target as HTMLElement).innerText);
    return name.trim().slice(0, 120);
  });

// The window as a new user opens it: reloaded, on its first page.
async function fresh(page: Page): Promise<void> {
  await page.reload();
  await waitFor(
    "the window",
    () =>
      withPageApi(
        page,
        () => (document.querySelector("#root")?.textContent?.length ?? 0) > 20,
      ),
    30_000,
  );
}

// The session the Help menu's item launches, read off the agent it
// opened, which then goes by SIGKILL, so its server can't end the
// session as it stops.
async function launch(page: Page, harness: Harness): Promise<string> {
  const before = sessionsRunning();
  await (
    await pageApi(page)
  ).evaluate((api, input) => api.run(api.guide.start(input)), {
    harness,
  } as const);
  // A new one: the last launch's agent may still be on its way out.
  const session = await waitFor(
    `${harness} to open`,
    async () => sessionsRunning().find((token) => !before.includes(token)),
    60_000,
  );
  kill(session, "SIGKILL");
  return session;
}

// Every process whose command line holds `text`.
function kill(text: string, signal: NodeJS.Signals): void {
  const table = execFileSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
  });
  for (const row of table.split("\n")) {
    const [pid, ...command] = row.trim().split(/\s+/);
    if (pid !== undefined && command.join(" ").includes(text)) {
      try {
        process.kill(Number(pid), signal);
      } catch {
        // Already gone.
      }
    }
  }
}

// The guide sessions the agents running now were opened on.
function sessionsRunning(): string[] {
  const table = execFileSync("ps", ["-Ao", "command="], { encoding: "utf8" });
  return [...table.matchAll(/"--session", ?"([\w-]{43})"/g)].flatMap(
    ([, token]) => (token === undefined ? [] : [token]),
  );
}

// The Terminal the launches opened, when the run started it: its
// windows closed and it quit, so none come back at its next launch (a
// killed Terminal restores them). Their agents are gone by then.
function quitTerminal(): void {
  if (!terminalWasRunning && running("Terminal")) {
    execFileSync("osascript", [
      "-e",
      'tell application "Terminal" to close every window saving no',
      "-e",
      'tell application "Terminal" to quit',
    ]);
  }
}

// The launch line the app types, run headless on `question`: the same
// role, server and tools, with each harness's flags for a run with no
// one at it.
function headless(harness: Harness, session: string, question: string): string {
  const line = guideCommand({
    harness,
    sm: smd,
    dataDir: app.dataDir,
    session,
  });
  const asked = `${line} -- ${shellQuote(question)}`;
  return harness === "claude"
    ? asked.replace(/^claude /, "claude -p --output-format json ")
    : asked.replace(/^codex /, "codex exec --json --skip-git-repo-check ");
}

// The harness run headless on a session, in the guide folder: its end,
// and what it answered.
function run(harness: Harness, session: string, question: string) {
  const child = spawn("/bin/sh", ["-c", headless(harness, session, question)], {
    cwd: guideFolder,
    stdio: ["ignore", "pipe", "pipe"],
  });
  own(child);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => logs.write(chunk));
  const ended = new Promise<void>((resolve) =>
    child.on("exit", () => resolve()),
  );
  const output = () =>
    harness === "claude" ? claudeOutput(stdout) : codexOutput(stdout);
  return { ended, output };
}

type Tour = {
  harness: Harness;
  question: string;
  passed: boolean;
  ms: number;
  firstAction: number | null;
  firstPoint: number | null;
  actions: number;
  pointed: string[];
  tokens: { total: number; output: number } | null;
  answer: string;
  timedOut: boolean;
};

// One how-to on a session of its own, since the agent's server ends its
// session as it stops.
async function tour(page: Page, harness: Harness, howTo: HowTo): Promise<Tour> {
  await fresh(page);
  const session = await launch(page, harness);
  const started = Date.now();
  const { ended, output } = run(harness, session, howTo.question);
  const pointed: { at: number; name: string }[] = [];
  let timedOut = false;
  for (;;) {
    const done = await Promise.race([
      ended.then(() => true),
      sleep(150).then(() => false),
    ]);
    const name = await pointedAt(page).catch(() => null);
    if (name !== null && pointed.at(-1)?.name !== name)
      pointed.push({ at: Date.now(), name });
    if (done) break;
    if (Date.now() - started > TOUR_LIMIT_MS) {
      timedOut = true;
      kill(session, "SIGTERM");
      await ended;
      break;
    }
  }
  const ms = Date.now() - started;
  const { answer, tokens } = output();
  const actions = driveStarts(started);
  const passed = pointed.some(({ name }) => howTo.point.test(name));
  return {
    harness,
    question: howTo.question,
    passed,
    ms,
    firstAction: actions[0] === undefined ? null : actions[0].at - started,
    firstPoint: pointed[0] === undefined ? null : pointed[0].at - started,
    actions: actions.length,
    pointed: pointed.map(({ name }) => name),
    tokens,
    answer,
    timedOut,
  };
}

function claudeOutput(stdout: string) {
  try {
    const result = JSON.parse(stdout) as {
      result?: string;
      usage?: Record<string, number>;
    };
    const usage = result.usage ?? {};
    const output = usage["output_tokens"] ?? 0;
    return {
      answer: result.result ?? "",
      tokens: {
        total:
          (usage["input_tokens"] ?? 0) +
          (usage["cache_creation_input_tokens"] ?? 0) +
          (usage["cache_read_input_tokens"] ?? 0) +
          output,
        output,
      },
    };
  } catch {
    return { answer: stdout.slice(-2000), tokens: null };
  }
}

function codexOutput(stdout: string) {
  let answer = "";
  let total = 0;
  let output = 0;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
        usage?: Record<string, number>;
      };
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      ) {
        answer = event.item.text ?? answer;
      }
      if (event.type === "turn.completed" && event.usage !== undefined) {
        total +=
          (event.usage["input_tokens"] ?? 0) +
          (event.usage["output_tokens"] ?? 0);
        output += event.usage["output_tokens"] ?? 0;
      }
    } catch {
      // Not an event.
    }
  }
  return { answer, tokens: total === 0 ? null : { total, output } };
}

// Round trips through `sm guide mcp` itself, as an agent makes them.
async function roundTrips(session: string) {
  const server = spawn(smd, ["guide", "mcp", "--session", session], {
    env: app.smdEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  own(server);
  let buffer = "";
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  // A server that ends fails what it was asked.
  server.once("exit", (code) => {
    for (const { reject } of waiting.values()) {
      reject(new Error(`sm guide mcp exited (${code}) before answering`));
    }
    waiting.clear();
  });
  server.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id?: number };
      buffer = buffer.slice(newline + 1);
      if (message.id !== undefined) {
        waiting.get(message.id)?.resolve(message);
        waiting.delete(message.id);
      }
      newline = buffer.indexOf("\n");
    }
  });
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise((resolve, reject) => {
      id += 1;
      const mine = id;
      const timer = setTimeout(() => {
        waiting.delete(mine);
        reject(new Error(`sm guide mcp didn't answer ${method} in 30 s`));
      }, 30_000);
      waiting.set(mine, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`,
      );
    });
  try {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "guide-eval", version: "1" },
    });
    const timed = async (name: string) => {
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        await call("tools/call", { name, arguments: {} });
        times.push(performance.now() - started);
      }
      return median(times);
    };
    return {
      look: await timed("look"),
      screenshot: await timed("screenshot"),
    };
  } finally {
    server.stdin.end();
    server.kill();
  }
}

function median(values: readonly number[]): number | null {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

// What the run started, ended however it ends (../../../testProcesses.mts): the
// agents' and the guide server's processes, the Terminal it opened, the
// app with its helpers.
const children = new Set<ChildProcess>();
function own(child: ChildProcess): void {
  children.add(child);
  child.once("exit", () => children.delete(child));
}
const forget = onRunEnd(() => {
  for (const child of children) child.kill("SIGKILL");
  try {
    quitTerminal();
  } finally {
    app.kill();
  }
});

const tours: Tour[] = [];
const trips: Record<string, unknown> = {};
const save = () =>
  writeFileSync(
    join(out, "tours.json"),
    JSON.stringify({ trips, tours }, null, 2),
  );
try {
  await app.launch(false);
  const page = await waitFor(
    "the window",
    async () => app.windows()[0],
    60_000,
  );
  for (const harness of harnesses) {
    await fresh(page);
    trips[harness] = await roundTrips(await launch(page, harness));
    for (const howTo of howTos) {
      const done = await tour(page, harness, howTo);
      tours.push(done);
      console.log(
        `${done.passed ? "pass" : "FAIL"} ${harness} ${(done.ms / 1000).toFixed(1)}s first point ${done.firstPoint ?? "-"} ms, ${done.tokens?.total ?? "?"} tokens: ${done.question} [${done.pointed.join(" | ")}]`,
      );
      save();
    }
  }
} finally {
  try {
    quitTerminal();
  } finally {
    await app.stop();
    logs.end();
    forget();
  }
}

for (const harness of harnesses) {
  const mine = tours.filter((done) => done.harness === harness);
  const of = (pick: (done: Tour) => number | null | undefined) =>
    median(
      mine.flatMap((done) => {
        const value = pick(done);
        return value === null || value === undefined ? [] : [value];
      }),
    );
  console.log(
    [
      `${harness}: ${mine.filter((done) => done.passed).length} of ${mine.length} passed`,
      `first action ${of((done) => done.firstAction)} ms, first point ${of((done) => done.firstPoint)} ms, a tour ${of((done) => done.ms)} ms`,
      `tokens ${of((done) => done.tokens?.total)} (output ${of((done) => done.tokens?.output)})`,
      `round trips ${JSON.stringify(trips[harness])}`,
    ].join("\n  "),
  );
}
