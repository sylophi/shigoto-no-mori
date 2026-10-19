// The terminal binary, built as it ships, on a sandbox data dir: what
// the engine's tests can't see from a service call. How a command line
// is refused, a person at a terminal, the shell's config and wrapper,
// and a script handed the terminal, its signals and its ending.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { type Sandbox, sandbox } from "../../engine/test/lib/sandbox.ts";
import { builtBinary } from "./lib/binary.ts";
import {
  type FakeApp,
  fakeApp,
  refusal,
  success,
} from "../../engine/test/lib/fakeApp.ts";
import { flavorNames } from "@shigomori/engine/flavor";
import { said as updateSaid } from "../src/commands/update.ts";
import { NAMESPACE_USAGE } from "../src/errors.ts";
import { documentedCommands } from "../src/help.ts";

let built: string;
beforeAll(() => {
  built = builtBinary("dev");
}, 300_000);

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const runAt = (cwd: string, ...args: string[]) =>
  box.runAt(built, "cli", cwd, args);

// What the binary did, run with more of the environment than the
// sandbox gives it: how it ended, killed by a signal included, and what
// it printed.
type Ended = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

const start = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
) => {
  const child = spawn(built, args, {
    cwd,
    env: { ...box.env("cli"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  const ended = new Promise<Ended>((resolve) =>
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    ),
  );
  return { child, ended };
};

// The binary handed `input` on stdin, as a harness runs a hook: how it
// ended and its stdout.
const piped = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  input: string,
) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(built, args, {
      cwd,
      env: { ...box.env("cli"), ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });

describe("a command line", () => {
  it("exits 2 on a command used wrongly, and 0 on help", async () => {
    const misuses = [
      ["--json", "config", "get"],
      ["--json", "config", "bogus"],
      ["--json", "config", "set", "--foo", "x", "y"],
    ];
    const runs = await Promise.all(
      misuses.map((args) => runAt(box.home, ...args)),
    );
    for (const run of runs) {
      assert.equal(run.code, 2, run.stdout);
      assert.equal((run.doc as { ok?: unknown }).ok, false, run.stdout);
    }
    assert.equal((await runAt(box.home, "--help")).code, 0);
  });

  it("traces each git it runs on stderr with --verbose, and nothing without", async () => {
    const repo = box.repo("traced");
    box.write("registry.json", {
      projects: [{ id: "T", name: "traced", path: repo }],
    });
    await box.migrate("cli");
    const traced = await runAt(repo, "--verbose", "list");
    assert.equal(traced.code, 0, traced.stderr);
    assert.match(
      traced.stderr,
      new RegExp(
        `^\\[git\\] worktree list --porcelain -z \\(cwd ${repo}\\)$`,
        "m",
      ),
    );
    assert.doesNotMatch((await runAt(repo, "list")).stderr, /\[git\]/);
  });

  it("lists into a reader that takes one line and quits, and ends cleanly with nothing said", async () => {
    const repo = box.repo("headed");
    for (let i = 0; i < 40; i++) {
      box.git(
        repo,
        "worktree",
        "add",
        "-q",
        "-b",
        `w${i}`,
        `${box.home}/w${i}`,
      );
    }
    box.write("registry.json", {
      projects: [{ id: "H", name: "headed", path: repo }],
    });
    await box.migrate("cli");
    for (const args of ["worktrees list --json", "worktrees list"]) {
      const headed = spawnSync(
        "bash",
        ["-o", "pipefail", "-c", `"${built}" ${args} | head -1`],
        { cwd: repo, env: box.env("cli"), encoding: "utf8" },
      );
      assert.equal(headed.status, 0, `${args}: ${headed.stderr}`);
      assert.equal(headed.stderr, "", args);
      assert.equal(headed.stdout.split("\n").length, 2, args);
    }
  });

  it("sets, reads and clears autoShelveDays, off while unset", async () => {
    const get = () =>
      runAt(box.home, "--json", "config", "get", "autoShelveDays");
    assert.deepEqual((await get()).doc, {
      ok: true,
      key: "autoShelveDays",
      value: null,
      set: false,
    });
    const refused = await runAt(
      box.home,
      "--json",
      "config",
      "set",
      "autoShelveDays",
      "0",
    );
    assert.equal(refused.code, 2);
    assert.deepEqual(refused.doc, {
      ok: false,
      error: "autoShelveDays must be a positive integer.",
    });
    assert.deepEqual(
      (await runAt(box.home, "--json", "config", "set", "autoShelveDays", "14"))
        .doc,
      { ok: true, key: "autoShelveDays", value: 14 },
    );
    assert.deepEqual((await get()).doc, {
      ok: true,
      key: "autoShelveDays",
      value: 14,
      set: true,
    });
    const listed = (
      (await runAt(box.home, "--json", "config", "list")).doc as {
        settings: ReadonlyArray<{ key: string }>;
      }
    ).settings.map(({ key }) => key);
    assert.equal(
      listed.indexOf("autoShelveDays"),
      listed.indexOf("autoPullPrimaryOnly") + 1,
    );
    await runAt(box.home, "--json", "config", "unset", "autoShelveDays");
    assert.equal(((await get()).doc as { set: boolean }).set, false);
  });

  it("refuses a command line in the Go sm's words, with no help page", async () => {
    const refusals: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["nosuch"], 'Unknown command "nosuch". Run `smd --help`.'],
      [["list", "--bogus"], 'Unknown option "--bogus".'],
      [["create", "--base"], 'Option "--base" requires a value.'],
      [["shell", "init"], "Usage: smd shell init <zsh|bash|fish>"],
      [
        ["shell", "bogus"],
        'Unknown subcommand "bogus". Usage: smd shell <install|uninstall|status|init>',
      ],
    ];
    const runs = await Promise.all(
      refusals.map(([args]) => start(box.home, args).ended),
    );
    runs.forEach((run, i) => {
      const [args, said] = refusals[i] as (typeof refusals)[number];
      assert.equal(run.code, 2, args.join(" "));
      assert.equal(run.stdout, "", args.join(" "));
      assert.equal(run.stderr, `smd: ${said}\n`);
    });
  });

  it("answers help from the catalog, and bare as a usage error", async () => {
    const [bare, page, rm, wtRm, namespace, asked] = await Promise.all(
      [
        [],
        ["--help"],
        ["rm", "--help"],
        ["wt", "rm", "-h"],
        ["projects"],
        ["help", "describe"],
      ].map((args) => start(box.home, args).ended),
    );
    assert.equal(bare?.code, 2);
    assert.equal(bare?.stdout, page?.stdout);
    assert.equal(page?.code, 0);
    assert.match(
      page?.stdout ?? "",
      /^smd: Shigoto no Mori CLI \(dev: targets ~\/\.smd\)\n/,
    );
    assert.match(
      page?.stdout ?? "",
      /\n {2}worktrees <command> {2,}Worktree commands\n/,
    );
    assert.match(
      rm?.stdout ?? "",
      /^Usage: smd worktrees rm \[<name>\] \[--stack\] \[-f\] \[--keep-branch\]\n {2}Remove a worktree\n/,
    );
    assert.equal(wtRm?.stdout, rm?.stdout);
    assert.match(namespace?.stdout ?? "", /^smd projects \(p for short\)\n/);
    assert.match(asked?.stdout ?? "", /^Usage: smd worktrees describe /);
    // -h past `--` is the command's own.
    const passed = await start(box.home, ["nosuch", "--", "-h"]).ended;
    assert.equal(passed.code, 2);
  });

  it("documents only the commands it has", async () => {
    // `help` is the help's own, never parsed.
    const commands = documentedCommands(flavorNames("dev")).filter(
      ([first]) => first !== "help",
    );
    const runs = await Promise.all(
      commands.map((words) => start(box.home, [...words, "--zzz"]).ended),
    );
    const missing = commands.filter(
      (_, i) => runs[i]?.stderr !== 'smd: Unknown option "--zzz".\n',
    );
    assert.deepEqual(missing, []);
  });

  it("tells an unknown subcommand the verbs the help documents", () => {
    const documented = documentedCommands(flavorNames("dev"));
    for (const namespace of ["projects", "config", "agents", "shell"]) {
      const told = /<([^>]+)>/.exec(NAMESPACE_USAGE[namespace] ?? "")?.[1];
      assert.deepEqual(
        told?.split("|"),
        documented.flatMap(([first, second]) =>
          first === namespace && second !== undefined ? [second] : [],
        ),
        namespace,
      );
    }
  });

  it("refuses the variables the stand-in flags replaced", async () => {
    for (const name of [
      "SHIGOMORI_UPDATE_FEED_URL",
      "SHIGOMORI_UPDATE_RELEASES_URL",
    ]) {
      const ended = await start(box.home, ["update"], {
        [name]: "http://127.0.0.1:1",
      }).ended;
      assert.equal(ended.code, 2, name);
    }
  });
});

// The last line a command printed, as the document it is.
const lastDoc = (stdout: string) =>
  JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;

// The agent verbs as a harness and an agent's shell reach them: the
// hooks installed into a harness's own file, a create from an agent's
// shell binding its session, a hook's event moving it, all as Go's sm
// printed them.
describe("agents", () => {
  // A run with `input` on stdin, the way a hook hands an event over.
  it("installs the hooks, binds the shell's session and follows its events", async () => {
    const claude = join(box.home, "claude-config");
    mkdirSync(claude);
    const env = {
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(box.home, "no-codex"),
    };
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [{ id: "R", name: "repo", path: repo }],
    });
    await box.migrate("cli");

    const status = await start(repo, ["--json", "agents", "status"], env).ended;
    assert.equal(status.code, 0);
    assert.deepEqual(lastDoc(status.stdout), {
      ok: true,
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          detected: true,
          path: join(claude, "settings.json"),
          hooks: "missing",
        },
        {
          id: "codex",
          label: "Codex",
          detected: false,
          path: join(box.home, "no-codex", "hooks.json"),
          hooks: "missing",
        },
      ],
    });
    // Every detected harness by default, Codex's missing config dir
    // left alone.
    const installed = await start(repo, ["agents", "install"], env).ended;
    assert.equal(installed.code, 0);
    assert.match(installed.stdout, /^installed the Claude Code hooks/);
    assert.match(
      readFileSync(join(claude, "settings.json"), "utf8"),
      / agents event --harness claude \|\| true"/,
    );
    assert.equal(
      (await start(repo, ["agents", "install", "pi"], env).ended).code,
      2,
    );

    const shell = { ...env, CLAUDE_CODE_SESSION_ID: "s1" };
    const created = await start(
      repo,
      ["--json", "create", "fox", "--no-setup"],
      shell,
    ).ended;
    assert.equal(created.code, 0, created.stderr);
    const fox = (
      created.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((doc) => doc["event"] === "created") as {
        worktree: {
          path: string;
          agentWorking: boolean;
          agentSessions: ReadonlyArray<{ session: string; state: string }>;
        };
      }
    ).worktree;
    assert.equal(fox.agentWorking, true);
    assert.deepEqual(
      fox.agentSessions.map(({ session, state }) => [session, state]),
      [["s1", "working"]],
    );

    // A hook's run: nothing on stdout and 0, whatever it was handed.
    const event = await piped(
      fox.path,
      ["agents", "event", "--harness", "claude"],
      env,
      JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }),
    );
    assert.deepEqual(event, { code: 0, stdout: "" });
    assert.deepEqual(await piped(fox.path, ["agents", "event"], env, "{nope"), {
      code: 0,
      stdout: "",
    });
    const row = await start(fox.path, ["--json", "agents", "idle"], env).ended;
    assert.equal(
      (lastDoc(row.stdout)["worktree"] as { agentWorking: boolean })
        .agentWorking,
      false,
    );

    const unbind = (...args: string[]) =>
      start(repo, ["--json", "agents", "unbind", ...args], env).ended;
    assert.deepEqual(
      lastDoc((await unbind("--harness", "claude", "--session", "s1")).stdout),
      { ok: true, unbound: true },
    );
    assert.deepEqual(
      lastDoc((await unbind("--harness", "claude", "--session", "s1")).stdout),
      { ok: true, unbound: false },
    );
    assert.equal((await unbind("--harness", "claude")).code, 2);
  });
});

describe("transfer", () => {
  let app: FakeApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("refuses a command line it can't use before asking the app", async () => {
    app = await fakeApp(() => []);
    box.write("loopback.json", app.file());
    const alpha = box.repo("alpha");
    const fox = `${box.home}/fox`;
    box.git(alpha, "worktree", "add", "-q", "-b", "fox", fox);
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const refused = [
      ["send", "--to", " "],
      ["send", "--from", "Studio"],
      ["bring", "--to", "Studio"],
      ["mirror", "--to", "a", "--from", "b"],
      ["bring", "--from", "Studio"],
      ["send", "--leave-out", "all"],
      ["--json", "send", "--setup", "--no-setup"],
      ["mirror", "--source", "keep"],
      ["send", "--source", "burn"],
      ["bring", "owl", "--clone-into", "/x"],
      ["send", "--clone-into", " "],
      ["mirrors", "extra"],
    ];
    const runs = await Promise.all(refused.map((args) => runAt(fox, ...args)));
    for (const [index, run] of runs.entries()) {
      assert.equal(run.code, 2, refused[index]?.join(" "));
    }
    assert.deepStrictEqual(app.received(), []);
  });

  it("asks the app over the loopback, printing and exiting as Go did", async () => {
    const notRunning = await runAt(box.home, "devices");
    assert.equal(notRunning.code, 1);
    assert.match(
      notRunning.stderr,
      /^smd: The Shigoto no Mori app isn't running/,
    );
    app = await fakeApp((request) => [
      request["channel"] === "control:devices"
        ? success(request, {
            thisDevice: { deviceId: "B", name: "Laptop" },
            devices: [
              { deviceId: "A", name: "Studio", platform: "darwin" },
              {
                deviceId: "C",
                name: "Away",
                platform: "darwin",
                block: "offline",
              },
              {
                deviceId: "D",
                name: "Private",
                platform: "linux",
                block: "not-sharing",
              },
            ],
          })
        : refusal(request, "No mirror runs for that worktree.", "no-mirror"),
    ]);
    // Into the binary's own copy of the data dir, which the run above
    // made.
    writeFileSync(
      join(box.side("cli"), "loopback.json"),
      JSON.stringify(app.file()),
    );
    const listed = await runAt(box.home, "devices");
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^This device is "Laptop"\.\n/);
    assert.match(listed.stdout, /\nStudio +darwin +connected\n/);
    assert.match(listed.stdout, /\nAway +darwin +not connected\n/);
    assert.match(
      listed.stdout,
      /\nPrivate +linux +doesn't share with other devices\n/,
    );
    const asked = await runAt(box.home, "--json", "devices");
    assert.deepEqual(asked.doc, {
      ok: true,
      thisDevice: { deviceId: "B", name: "Laptop" },
      devices: [
        { deviceId: "A", name: "Studio", platform: "darwin" },
        { deviceId: "C", name: "Away", platform: "darwin", block: "offline" },
        {
          deviceId: "D",
          name: "Private",
          platform: "linux",
          block: "not-sharing",
        },
      ],
    });
    const refusedStop = await runAt(box.home, "--json", "worktrees", "mirrors");
    assert.equal(refusedStop.code, 1);
    assert.deepEqual(refusedStop.doc, {
      ok: false,
      error: "No mirror runs for that worktree.",
      code: "no-mirror",
    });
  });
});

// A key to type, or what the case does instead: its own checks, which
// may fail it with the menu still up.
type Key = string | (() => string);

// `under-load.mts` beside this file repeats these, each case SM_TERMINAL_REPEATS more
// times, with busy loops beside them.
describe(
  "at a terminal",
  { repeats: Number(process.env["SM_TERMINAL_REPEATS"] ?? 0) },
  () => {
    // What the menu's help line says in either mode. The menu draws it
    // once its keys reach it, so a key typed after it lands in the menu.
    const HELP = "enter select";
    const STEP_DEADLINE = 10_000;

    // The built binary in a terminal of its own (BSD script's pty), each
    // key typed once the screen shows the text paired with it, and after
    // it the help line of a menu ready for the key: what it showed,
    // stdout and stderr together, escapes and all.
    const inTerminal = async (
      args: ReadonlyArray<string>,
      keys: ReadonlyArray<readonly [shown: string, key: Key]>,
      env: NodeJS.ProcessEnv = {},
      // Typed once the screen shows the text, with no menu to wait on:
      // what the program the binary handed the terminal reads.
      after?: readonly [shown: string, text: string],
    ) => {
      // script takes no socket for its input, which node's pipes are, so
      // cat hands it a pipe.
      const command = 'cat | script -q /dev/null "$@"';
      // In a process group of its own, so ending it ends cat and script
      // with sh, and script's end hangs the binary up.
      const child = spawn("sh", ["-c", command, "sh", built, ...args], {
        cwd: box.home,
        env: {
          ...box.env("cli"),
          TERM: "xterm-256color",
          ...env,
        },
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      const stop = () => {
        // No pid is a spawn that failed, and -0 would be this process's
        // own group.
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group has ended already.
        }
      };
      // A case that times out never reaches the finally below.
      onTestFinished(stop);
      let shown = "";
      let closed = false;
      // Each check runs again on every chunk the screen gets and once the
      // binary ends.
      const checks = new Set<() => void>();
      const recheck = () => {
        for (const check of checks) check();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        shown += chunk;
        recheck();
      });
      const ended = new Promise((resolve) =>
        child.on("close", () => {
          closed = true;
          recheck();
          resolve(undefined);
        }),
      );
      // Where `text` shows from `from` on, once it does. A step shows in
      // well under a second; one that hasn't in STEP_DEADLINE fails naming
      // what it waited for and the screen, where the case's own timeout
      // would say neither.
      const showing = (text: string, from: number) =>
        new Promise<number>((resolve, reject) => {
          const deadline = setTimeout(() => {
            checks.delete(check);
            reject(
              new Error(`Waited ${STEP_DEADLINE} ms for ${text}:\n${shown}`),
            );
          }, STEP_DEADLINE);
          const check = () => {
            const at = shown.indexOf(text, from);
            if (at !== -1) resolve(at);
            else if (closed)
              reject(new Error(`Never showed ${text}:\n${shown}`));
            else return;
            clearTimeout(deadline);
            checks.delete(check);
          };
          checks.add(check);
          check();
        });
      const type = async (
        steps: ReadonlyArray<readonly [string, Key]>,
      ): Promise<void> => {
        const [step, ...rest] = steps;
        if (step === undefined) return;
        await showing(HELP, await showing(step[0], shown.length));
        const [, key] = step;
        child.stdin.write(typeof key === "string" ? key : key());
        return type(rest);
      };
      try {
        await type(keys);
        if (after !== undefined) {
          await showing(after[0], shown.length);
          child.stdin.write(after[1]);
          // Ended only once the binary has read it, or past the step's
          // deadline: script hands the end of input to the terminal apart
          // from the text before it, and under load it can come first.
          await Promise.race([ended, sleep(STEP_DEADLINE)]);
        }
        child.stdin.end();
        await ended;
        return shown;
      } finally {
        stop();
      }
    };
    const DOWN = "\u001b[B";

    // Two projects, beta with a worktree "fox".
    const projects = async () => {
      const alpha = box.repo("alpha");
      const beta = box.repo("beta");
      box.git(beta, "worktree", "add", "-q", "-b", "fox", `${box.home}/fox`);
      box.write("registry.json", {
        projects: [
          { id: "A", name: "alpha", path: alpha },
          { id: "B", name: "beta", path: beta },
        ],
      });
      await box.migrate("cli");
    };

    it("picks a project, then one of its worktrees", async () => {
      await projects();
      const shown = await inTerminal(
        ["path"],
        [
          ["Select a project:", DOWN],
          ["▸ beta", "\r"],
          ["Select a worktree in beta:", DOWN],
          ["▸ fox", "\r"],
        ],
      );
      assert.match(shown, /NAME +BRANCH +SYNC +CHANGES/);
      assert.ok(shown.trimEnd().endsWith(`${box.home}/fox`), shown);
    });

    it("takes a yes typed to a question asked after git ran, as a menu takes its key", async () => {
      const root = join(box.home, "found");
      mkdirSync(root);
      for (const name of ["one", "two"]) {
        const repo = box.repo(name);
        renameSync(repo, join(root, name));
      }
      await box.migrate("cli");
      const shown = await inTerminal(
        ["projects", "add", root, "--all"],
        [],
        {},
        ["[y/N]", "y\n"],
      );
      assert.match(shown, /added one /);
      assert.match(shown, /added two /);
    });

    it("draws the menu with CI set in the environment", async () => {
      await projects();
      const shown = await inTerminal(
        ["path"],
        [
          ["Select a project:", DOWN],
          ["▸ beta", "\r"],
          ["Select a worktree in beta:", DOWN],
          ["▸ fox", "\r"],
        ],
        { CI: "true" },
      );
      assert.ok(shown.trimEnd().endsWith(`${box.home}/fox`), shown);
    });

    it("writes stderr as it is, with no color of Bun's", async () => {
      const shown = await inTerminal(["path", "nosuch"], []);
      // After script's echo of the end of input.
      assert.ok(
        shown.endsWith(
          '\u001b[31msmd:\u001b[0m No worktree named "nosuch".\r\n',
        ),
        JSON.stringify(shown),
      );
    });

    it("colors a terminal's lines with NO_COLOR set but empty, as Go did", async () => {
      const shown = await inTerminal(["path", "nosuch"], [], { NO_COLOR: "" });
      assert.ok(
        shown.endsWith(
          '\u001b[31msmd:\u001b[0m No worktree named "nosuch".\r\n',
        ),
        JSON.stringify(shown),
      );
    });

    it("enters the worktree picked from the menus, and its shell has the keys", async () => {
      await projects();
      const entered = join(box.home, "entered");
      // An interactive shell takes the terminal's foreground group, as a
      // person's does.
      box.fakeBin("job-shell", `PS1='shell-ready> ' exec /bin/zsh -f -i`);
      const shown = await inTerminal(
        ["cd"],
        [
          ["Select a project:", DOWN],
          ["▸ beta", "\r"],
          ["Select a worktree in beta:", DOWN],
          ["▸ fox", "\r"],
        ],
        { SHELL: "job-shell" },
        ["shell-ready>", `pwd > '${entered}'; exit\r`],
      );
      assert.equal(readFileSync(entered, "utf8"), `${box.home}/fox\n`);
      assert.doesNotMatch(shown, /EIO|error:/i);
    });

    it("enters a worktree in the account's login shell when $SHELL is empty", async () => {
      const { worktree } = await scripted();
      const entered = join(box.home, "entered");
      box.fakeBin("account-shell", `pwd > '${entered}'`);
      box.fakeBin("dscl", 'echo "UserShell: $(command -v account-shell)"');
      await inTerminal(["cd", "-p", "repo", "w"], [], { SHELL: "" });
      assert.equal(readFileSync(entered, "utf8"), `${worktree}\n`);
    });

    it("edits the settings in $EDITOR and saves what it left", async () => {
      box.write("registry.json", { projects: [] });
      await box.migrate("cli");
      box.fakeBin(
        "fake-editor",
        `grep -q '"launchScripts"' "$1" && exit 9; printf '{"launchScripts": false}' > "$1"`,
      );
      await inTerminal(["config", "edit"], [], { EDITOR: "fake-editor" });
      const got = await runAt(box.home, "config", "get", "launchScripts");
      assert.equal(got.stdout, "false\n");
      // Without a terminal there is no editor to wait on.
      assert.equal((await runAt(box.home, "--json", "config", "edit")).code, 2);
    });

    it("refuses an edit when the settings changed while the editor was open, and keeps the edit", async () => {
      box.write("registry.json", { projects: [] });
      await box.migrate("cli");
      // Another save lands while the editor is open.
      box.fakeBin(
        "busy-editor",
        `'${built}' config set portPool true >/dev/null; printf '{"launchScripts": false}' > "$1"`,
      );
      await inTerminal(["config", "edit"], [], { EDITOR: "busy-editor" });
      const kept = await runAt(box.home, "config", "get", "portPool");
      assert.equal(kept.stdout, "true\n");
      const unchanged = await runAt(box.home, "config", "get", "launchScripts");
      assert.equal(unchanged.stdout, "true\n");
    });

    it("leaves no process behind when a case fails with the menu up", async () => {
      await projects();
      await assert.rejects(
        inTerminal(
          ["path"],
          [
            [
              "Select a project:",
              () => {
                throw new Error("the case failed");
              },
            ],
          ],
        ),
        /the case failed/,
      );
      // pgrep exits 1 once nothing runs the binary.
      await vi.waitFor(() =>
        assert.throws(() => execFileSync("pgrep", ["-f", built])),
      );
    });

    it("filters by name, and esc cancels", async () => {
      await projects();
      const shown = await inTerminal(
        ["path"],
        [
          [HELP, "/"],
          ["type to filter", "be"],
          ["/be", "\r"],
          ["Select a worktree in beta:", "\u001b"],
        ],
      );
      assert.match(shown, /Cancelled\./);
    });
    it("leaves what was typed before it to the shell", async () => {
      // A line typed while sm runs, before anything asks for one: the
      // shell's next read gets it (stdinFd.ts reads nothing early).
      const script = '"$0" path nosuch; read line; echo "after: $line"';
      const child = spawn(
        "sh",
        [
          "-c",
          'cat | script -q /dev/null "$@"',
          "sh",
          "sh",
          "-c",
          script,
          built,
        ],
        {
          cwd: box.home,
          env: { ...box.env("cli"), TERM: "xterm-256color" },
          stdio: ["pipe", "pipe", "ignore"],
          detached: true,
        },
      );
      onTestFinished(() => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group has ended already.
        }
      });
      let shown = "";
      child.stdout.on("data", (chunk: Buffer) => {
        shown += chunk;
        if (shown.includes("after: ")) child.stdin.end();
      });
      child.stdin.write("early-line\n");
      await new Promise((resolve) => child.on("close", resolve));
      assert.match(shown, /after: early-line/);
    });
  },
);

describe("the v3 migration", () => {
  // A 2.x data dir: a project with worktrees a and b in its v2 folder.
  const v2 = () => {
    const repo = box.repo("repo", {
      "package.json": JSON.stringify({ scripts: { dev: "dev" } }),
    });
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
    });
    const dataDir = box.side("cli");
    const at = join(dataDir, "worktrees", "repo");
    for (const name of ["a", "b"]) {
      box.git(repo, "worktree", "add", "-q", "-b", name, join(at, name));
    }
    return { repo, dataDir, a: join(at, "a"), b: join(at, "b") };
  };

  it("is left to the app by a hook, a script and a read, which read what v2 left", async () => {
    const { repo, dataDir, a, b } = v2();
    const hook = await piped(
      a,
      ["agents", "event", "--harness", "claude"],
      {},
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1" }),
    );
    assert.deepEqual(hook, { code: 0, stdout: "" });
    const scripts = await runAt(a, "--json", "run");
    assert.equal(scripts.code, 0, scripts.stderr);
    assert.deepEqual(
      (scripts.doc as { scripts: ReadonlyArray<{ name: string }> }).scripts.map(
        ({ name }) => name,
      ),
      ["dev"],
    );
    const listed = await runAt(repo, "--json", "list");
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stderr, "");
    assert.deepEqual(
      (listed.doc as ReadonlyArray<{ path: string }>).map(({ path }) => path),
      [repo, a, b],
    );
    const set = await runAt(
      a,
      "--json",
      "config",
      "set",
      "autoShelveDays",
      "9",
    );
    assert.equal(set.code, 1);
    assert.equal((set.doc as { code: string }).code, "store-unmigrated");
    // A change on disk is refused before it starts, not after.
    const moved = await runAt(a, "--json", "move", join(box.home, "elsewhere"));
    assert.equal((moved.doc as { code: string }).code, "store-unmigrated");
    assert.ok(!existsSync(join(box.home, "elsewhere")));
    const created = await runAt(repo, "--json", "create", "c", "--no-setup");
    assert.equal((created.doc as { code: string }).code, "store-unmigrated");
    assert.ok(existsSync(a) && existsSync(b));
    assert.ok(!existsSync(join(dataDir, "wt")));
    assert.ok(!existsSync(join(dataDir, "store.db")));
  });

  it("reads a 2.x data dir with settings and no projects as one", async () => {
    box.write("config.json", { autoShelveDays: 5 });
    const got = await runAt(box.home, "config", "get", "autoShelveDays");
    assert.equal(got.stdout, "5\n");
    assert.ok(!existsSync(join(box.side("cli"), "store.db")));
  });

  it("is made by doctor --fix, which leaves a worktree something runs in", async () => {
    const { dataDir, a, b } = v2();
    const doctor = async (...args: string[]) =>
      (await runAt(box.home, "--json", "doctor", ...args)).doc as {
        readonly repaired: ReadonlyArray<string>;
        readonly checks: ReadonlyArray<{ id: string; detail: string }>;
      };
    const read = await doctor();
    assert.ok(read.checks.some(({ id }) => id === "v2-data-dir"));
    assert.ok(existsSync(a) && existsSync(b));
    const held = spawn("sleep", ["30"], { cwd: b, stdio: "ignore" });
    onTestFinished(() => {
      held.kill();
    });
    // Run from inside a, as a person would: sm and the lsof it runs
    // don't hold it back.
    const fixed = (await runAt(a, "--json", "doctor", "--fix")).doc as {
      readonly repaired: ReadonlyArray<string>;
      readonly checks: ReadonlyArray<{ id: string; detail: string }>;
    };
    assert.deepEqual(fixed.repaired.slice(0, 2), [
      "imported the projects and settings from v2",
      "moved 1 worktree into wt/",
    ]);
    assert.ok(existsSync(join(dataDir, "wt", "repo", "a")));
    assert.ok(existsSync(b));
    assert.match(
      fixed.checks.find(({ id }) => id === "project-wt-moves")?.detail ?? "",
      new RegExp(`close sleep \\(${held.pid}\\), which runs in it`),
    );
    assert.ok(!fixed.checks.some(({ id }) => id === "v2-data-dir"));
  });
});

describe("doctor", () => {
  it("still gives its checklist when the store won't open", async () => {
    writeFileSync(join(box.home, "seed", "store.db"), "not a database");
    const run = await runAt(box.home, "--json", "doctor");
    const doc = run.doc as {
      readonly ok: boolean;
      readonly checks: ReadonlyArray<{ readonly status: string }>;
    };
    assert.equal(run.code, 1);
    assert.equal(doc.ok, false);
    assert.ok(doc.checks.some(({ status }) => status === "fail"));
  });
});

// --- shell integration, cd and run ---------------------------------------

describe("shell", () => {
  const BEGIN = "# >>> shigomori-dev shell integration >>>";

  // A home of its own, with `files` in it.
  const homeWith = (files: Record<string, string>) => {
    const home = join(box.home, "home");
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(home, file)), { recursive: true });
      writeFileSync(join(home, file), content, { mode: 0o600 });
    }
    return home;
  };

  it("installs the hook in the shell's config and takes it out again", async () => {
    const home = homeWith({ ".zshrc": "export A=1\n" });
    const run = (...args: string[]) =>
      start(box.home, args, { HOME: home, SHELL: "/bin/zsh" }).ended;
    const states = async () =>
      (
        JSON.parse((await run("--json", "shell", "status")).stdout) as {
          shells: ReadonlyArray<{ shell: string; state: string }>;
        }
      ).shells.map(({ shell, state }) => `${shell}:${state}`);
    assert.deepEqual(await states(), [
      "zsh:missing",
      "bash:missing",
      "fish:missing",
    ]);
    assert.equal((await run("shell", "install")).code, 0);
    // Idempotent.
    assert.equal((await run("shell", "install", "zsh")).code, 0);
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    assert.equal(rc.split(BEGIN).length, 2, rc);
    assert.ok(rc.startsWith("export A=1\n\n"), rc);
    assert.deepEqual(await states(), [
      "zsh:installed",
      "bash:missing",
      "fish:missing",
    ]);
    assert.equal((await run("shell", "install", "tcsh")).code, 2);
    assert.equal((await run("shell", "uninstall")).code, 0);
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), "export A=1\n");
  });

  it("leaves an edited hook alone", async () => {
    const home = homeWith({
      ".zshrc": `${BEGIN}\necho mine\n# <<< shigomori-dev shell integration <<<\n`,
    });
    const before = readFileSync(join(home, ".zshrc"), "utf8");
    const run = (...args: string[]) =>
      start(box.home, args, { HOME: home }).ended;
    assert.equal((await run("shell", "install", "zsh")).code, 1);
    assert.equal((await run("shell", "uninstall")).code, 1);
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), before);
  });

  // A dotfiles manager's link stays one, and the file it tracks gets
  // the hook.
  it("writes a symlinked config through its link", async () => {
    const home = homeWith({ "dotfiles/zshrc": "export A=1\n" });
    symlinkSync("dotfiles/zshrc", join(home, ".zshrc"));
    const run = (...args: string[]) =>
      start(box.home, args, { HOME: home }).ended;
    assert.equal((await run("shell", "install", "zsh")).code, 0);
    assert.ok(lstatSync(join(home, ".zshrc")).isSymbolicLink());
    assert.match(
      readFileSync(join(home, "dotfiles/zshrc"), "utf8"),
      /^export A=1\n\n# >>> shigomori-dev shell integration >>>\n/,
    );
    assert.equal((await run("shell", "uninstall")).code, 0);
    assert.ok(lstatSync(join(home, ".zshrc")).isSymbolicLink());
    assert.equal(
      readFileSync(join(home, "dotfiles/zshrc"), "utf8"),
      "export A=1\n",
    );
  });

  it("names the login shell the engine runs: $SHELL's over the account's, the account's with no $SHELL", async () => {
    box.fakeBin("dscl", 'echo "UserShell: /bin/bash"');
    const loginShell = async (SHELL: string) =>
      (
        JSON.parse(
          (
            await start(box.home, ["--json", "shell", "status"], { SHELL })
              .ended
          ).stdout,
        ) as { loginShell: string }
      ).loginShell;
    assert.equal(await loginShell("/bin/zsh"), "zsh");
    assert.equal(await loginShell(""), "bash");
  });
});

// A project "repo" with a linked worktree "w", and a package.json whose
// scripts a fake npm runs: each says how the run should end.
const npm = `name=$2; shift 2
case "$name" in
  ok) exit 0 ;;
  fail) exit 3 ;;
  term) kill -TERM $$ ;;
  kill) kill -KILL $$ ;;
  segv) kill -SEGV $$ ;;
  args)
    for arg in "$@"; do echo "[$arg]"; done
    pwd
    env | grep '^SHIGOMORI_' | grep -v '^SHIGOMORI_DATA_DIR=' | sort ;;
  wait)
    trap 'echo INT >> "$MARK"; exit 7' INT
    trap 'echo TERM >> "$MARK"; exit 9' TERM
    : > "$READY"
    while :; do sleep 0.02; done ;;
  sleep) : > "$READY"; exec sleep 30 ;;
esac`;

const scripted = async () => {
  const scripts = [
    "ok",
    "fail",
    "term",
    "kill",
    "segv",
    "args",
    "wait",
    "sleep",
  ];
  const repo = box.repo("repo", {
    "package.json": JSON.stringify({
      scripts: Object.fromEntries(scripts.map((name) => [name, name])),
    }),
    "sub/package.json": JSON.stringify({ scripts: { nested: "x" } }),
  });
  const worktree = join(box.home, "w");
  box.git(repo, "worktree", "add", "-q", "-b", "w", worktree);
  box.write("registry.json", {
    projects: [{ id: "R", name: "repo", path: repo }],
  });
  box.fakeBin("npm", npm);
  await box.migrate("cli");
  return { repo, worktree };
};

describe("cd", () => {
  it("writes the worktree's path to the wrapper's directive file", async () => {
    const { repo, worktree } = await scripted();
    const cdFile = join(box.home, "cd");
    writeFileSync(cdFile, "");
    const ended = await start(repo, ["cd", "w"], {
      SHIGOMORI_CD_FILE: cdFile,
    }).ended;
    assert.equal(ended.code, 0);
    assert.equal(readFileSync(cdFile, "utf8"), `${worktree}\n`);
    // --json is refused outright, and without a terminal so is a cd
    // with no directive file to write.
    assert.equal((await runAt(repo, "--json", "cd", "w")).code, 2);
    assert.equal((await start(repo, ["cd", "w"]).ended).code, 2);
  });

  it("switches within the project, by name or as `worktrees <name>`", async () => {
    const { repo, worktree } = await scripted();
    for (const args of [
      ["worktrees", "switch", "w"],
      ["wt", "w"],
    ]) {
      const cdFile = join(box.home, "cd");
      writeFileSync(cdFile, "");
      const ended = await start(repo, args, {
        SHIGOMORI_CD_FILE: cdFile,
      }).ended;
      assert.equal(ended.code, 0, args.join(" "));
      assert.equal(readFileSync(cdFile, "utf8"), `${worktree}\n`);
    }
    // Bare, it asks which worktree, which takes a terminal.
    const bare = await start(repo, ["worktrees", "switch"]).ended;
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /needs an interactive terminal/);
  });

  // The wrapper as a shell evals it, around this build.
  it.each(["zsh", "bash"])("moves %s through the wrapper", async (shell) => {
    const { repo, worktree } = await scripted();
    const script = [
      `eval "$(smd shell init ${shell})"`,
      "smd cd w",
      "pwd",
      "smd run fail",
      'echo "rc=$?"',
      "smd shell status --json",
      'echo "left=$SHIGOMORI_CD_FILE"',
    ].join("\n");
    const { stdout } = await new Promise<{ stdout: string }>(
      (resolve, reject) =>
        execFile(
          shell,
          ["-f", "-c", script],
          {
            cwd: repo,
            env: {
              ...box.env("cli"),
              PATH: `${dirname(built)}:${box.env("cli").PATH}`,
            },
          },
          (error, out) => (error ? reject(error) : resolve({ stdout: out })),
        ),
    );
    const [where, rc, statusLine, left] = stdout.trim().split("\n");
    assert.equal(where, worktree);
    assert.equal(rc, "rc=3");
    assert.equal(
      (JSON.parse(statusLine ?? "") as { active: boolean }).active,
      true,
    );
    assert.equal(left, "left=");
  });
});

// Once the file is there.
const appeared = async (file: string): Promise<void> => {
  if (existsSync(file)) return;
  await sleep(10);
  return appeared(file);
};

describe("run", () => {
  it("runs the script with the store's write lock held elsewhere", async () => {
    const { worktree } = await scripted();
    // The store made, as the first run does.
    assert.equal((await start(worktree, ["run", "ok"]).ended)?.code, 0);
    const holder = new DatabaseSync(join(box.side("cli"), "store.db"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const ran = await start(worktree, ["run", "ok"]).ended;
      assert.equal(ran?.code, 0, ran?.stderr);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  }, 30_000);

  it("ends as the script did", async () => {
    const { worktree } = await scripted();
    const [ok, fail, term, kill] = await Promise.all(
      ["ok", "fail", "term", "kill"].map(
        (script) => start(worktree, ["run", script]).ended,
      ),
    );
    assert.equal(ok?.code, 0);
    assert.equal(fail?.code, 3);
    assert.equal(term?.signal, "SIGTERM");
    assert.equal(kill?.signal, "SIGKILL");
    // A shell reads a death by signal as 128+n.
    const shellSees = execFileSync(
      "/bin/sh",
      ["-c", `"$0" run kill; echo $?`, built],
      { cwd: worktree, env: box.env("cli"), encoding: "utf8" },
    );
    assert.equal(shellSees.trim(), "137");
    // A crash is reported as 128+n, never raised on sm.
    const crashed = await start(worktree, ["run", "segv"]).ended;
    assert.deepEqual([crashed.code, crashed.signal], [139, null]);
  });

  it("passes what follows -- to the script as it is, from the worktree's root", async () => {
    const { repo } = await scripted();
    const ran = await start(
      `${repo}/sub`,
      [
        "run",
        "args",
        "--",
        "--json",
        "-h",
        "--help",
        "a b",
        "--",
        "--project-id",
      ],
      { SHIGOMORI_CD_FILE: "/x", SHIGOMORI_SCRIPT_NAME: "stale" },
    ).ended;
    assert.match(
      ran.stdout,
      new RegExp(
        `^\\[--\\]\\n\\[--json\\]\\n\\[-h\\]\\n\\[--help\\]\\n\\[a b\\]\\n\\[--\\]\\n\\[--project-id\\]\\n${repo}\\n`,
      ),
    );
    assert.match(ran.stdout, /SHIGOMORI_SCRIPT_NAME=args/);
    assert.doesNotMatch(ran.stdout, /SHIGOMORI_CD_FILE/);
  });

  it("lists and runs a justfile's recipes and a Makefile's targets beside package.json's scripts", async () => {
    const { repo } = await scripted();
    writeFileSync(join(repo, "justfile"), "check:\n    echo check\n");
    writeFileSync(join(repo, "Makefile"), "build:\n\tgo build\n");
    box.fakeBin(
      "just",
      'for arg in "$@"; do echo "[$arg]"; done\necho "$SHIGOMORI_SCRIPT_NAME"',
    );
    const listed = (await runAt(repo, "--json", "run")).doc as {
      packageManager: string | null;
      scripts: ReadonlyArray<Record<string, string>>;
    };
    assert.equal(listed.packageManager, "npm");
    assert.deepEqual(listed.scripts.slice(-2), [
      {
        name: "just check",
        command: "echo check",
        file: "justfile",
        label: "check",
      },
      {
        name: "make build",
        command: "go build",
        file: "Makefile",
        label: "build",
      },
    ]);
    assert.deepEqual(listed.scripts[0], {
      name: "ok",
      command: "ok",
      file: "package.json",
      label: "ok",
    });
    // Named whole, the way the app does, or as two words at a terminal.
    const [whole, split] = await Promise.all([
      start(repo, ["run", "just check", "a"]).ended,
      start(repo, ["run", "just", "check", "b"]).ended,
    ]);
    assert.equal(whole.stdout, "[check]\n[a]\njust check\n");
    assert.equal(split.stdout, "[check]\n[b]\njust check\n");
  });

  it("is no-scripts without a package.json, justfile or Makefile", async () => {
    const repo = box.repo("bare");
    box.write("registry.json", {
      projects: [{ id: "B", name: "bare", path: repo }],
    });
    await box.migrate("cli");
    const listed = await runAt(repo, "--json", "run");
    assert.equal(listed.code, 1);
    assert.deepEqual(listed.doc, {
      ok: false,
      error: `No package.json, justfile or Makefile in ${repo}.`,
      code: "no-scripts",
    });
  });

  // A signal sent to sm reaches the script, and sm ends as the script
  // did.
  it.each([
    ["SIGINT", "wait"],
    ["SIGTERM", "wait"],
    ["SIGTERM", "sleep"],
    ["SIGINT", "sleep"],
  ] as const)("passes %s on to the %s script", async (signal, script) => {
    const { worktree } = await scripted();
    const mark = join(box.home, "mark");
    const ready = join(box.home, "ready");
    const run = start(worktree, ["run", script], { MARK: mark, READY: ready });
    await appeared(ready);
    run.child.kill(signal);
    const ended = await run.ended;
    if (script === "wait") {
      assert.equal(readFileSync(mark, "utf8"), `${signal.slice(3)}\n`);
      assert.equal(ended.code, signal === "SIGINT" ? 7 : 9);
    } else {
      assert.equal(ended.signal, signal);
    }
  });
});

describe("app", () => {
  it("takes no arguments, and the dev build has no installed app to open", async () => {
    const [extra, dev] = await Promise.all([
      runAt(box.home, "app", "now"),
      runAt(box.home, "app"),
    ]);
    assert.equal(extra.code, 2);
    assert.equal(extra.stderr, "smd: app takes no arguments.\n");
    assert.equal(dev.code, 1);
    assert.equal(
      dev.stderr,
      "smd: This is the dev CLI; the dev app isn't installed. Run `pnpm dev` in a checkout instead.\n",
    );
  });

  it("names the app an update restarts, each flavor's own", () => {
    const restarting = { phase: "restarting", version: "9.9.9" } as const;
    assert.equal(
      updateSaid(restarting, flavorNames("prod").appName, String),
      "restarting Shigoto no Mori to install 9.9.9",
    );
    assert.equal(
      updateSaid(restarting, flavorNames("v3").appName, String),
      "restarting Shigoto no Mori (v3) to install 9.9.9",
    );
  });

  it("names the app it opened or couldn't, each flavor's own", async () => {
    for (const [flavor, line] of [
      ["prod", "opened Shigoto no Mori"],
      ["v3", "opened Shigoto no Mori (v3)"],
      ["lab", "opened Shigoto no Mori (lab)"],
    ] as const) {
      const binary = builtBinary(flavor);
      box.fakeBin("open", "exit 1");
      const refused = await box.runAt(binary, "cli", box.home, ["app"]);
      assert.equal(refused.code, 1);
      assert.ok(
        refused.stderr.endsWith(
          `Couldn't open ${flavorNames(flavor).appName}. Is the app installed?\n`,
        ),
        refused.stderr,
      );
      box.fakeBin("open", `printf '%s\\n' "$@" > '${box.home}/open.args'`);
      const opened = await box.runAt(binary, "cli", box.home, ["app"]);
      assert.equal(opened.code, 0);
      assert.equal(opened.stdout, `${line}\n`);
      assert.match(
        readFileSync(join(box.home, "open.args"), "utf8"),
        new RegExp(`-b\\n${flavorNames(flavor).bundleId}\\n$`),
      );
    }
  }, 300_000);
});

describe("worktrees edit", () => {
  it("opens the file in the chosen editor, or with its default app", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const file = join(alpha, "src", "a.txt");
    mkdirSync(dirname(file));
    writeFileSync(file, "a\n");
    const calledWith = (name: string) =>
      readFileSync(join(box.home, `${name}.args`), "utf8").trimEnd();
    for (const name of ["open", "zed"]) {
      box.fakeBin(name, `printf '%s\\n' "$@" > '${box.home}/${name}.args'`);
    }

    // Unset, the file's default app, a relative path read from cwd.
    const fromCwd = await runAt(join(alpha, "src"), "--json", "edit", "a.txt");
    assert.deepEqual(fromCwd.doc, { ok: true, path: file });
    assert.equal(calledWith("open"), file);

    // An executable's default app would run it. A named worktree reads
    // the path from its root.
    chmodSync(file, 0o755);
    const named = await runAt(
      box.home,
      "--json",
      "wt",
      "edit",
      "-p",
      "alpha",
      "src/a.txt",
      "root",
    );
    assert.deepEqual(named.doc, { ok: true, path: file });
    assert.equal(calledWith("open"), `-t\n${file}`);

    // A tool that isn't an editor isn't one here either.
    const refused = await runAt(
      box.home,
      "--json",
      "config",
      "set",
      "editor",
      "lazygit",
    );
    assert.equal(refused.code, 2);
    // Stored anyway (a v2 config.json, a catalog entry since dropped),
    // the file opens with its default app.
    const store = new DatabaseSync(join(box.side("cli"), "store.db"));
    store
      .prepare("INSERT INTO device_config (key, value) VALUES (?, ?)")
      .run("editor", JSON.stringify("lazygit"));
    store.close();
    assert.equal((await runAt(alpha, "edit", "src/a.txt")).code, 0);
    assert.equal(calledWith("open"), `-t\n${file}`);

    // An editor with a command takes the worktree along.
    assert.equal(
      (await runAt(box.home, "config", "set", "editor", "zed")).code,
      0,
    );
    assert.equal((await runAt(alpha, "edit", "src/a.txt")).code, 0);
    assert.equal(calledWith("zed"), `${alpha}\n${file}`);

    assert.equal((await runAt(alpha, "edit", "src")).code, 1);
    const missing = await runAt(alpha, "--json", "edit", "src/gone.txt");
    assert.equal(missing.code, 1);
    assert.equal((missing.doc as { code?: string }).code, "missing-file");
  });
});

describe("worktrees link", () => {
  it("prints the link that opens the worktree in the app, on this device", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const printed = await runAt(alpha, "link");
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(
      printed.stdout,
      /^shigomori-dev:\/\/open\/devices\/[0-9a-f-]{36}\/projects\/A\/worktrees\/[0-9a-f]+\n$/,
    );
    const asked = await runAt(
      box.home,
      "--json",
      "wt",
      "link",
      "-p",
      "alpha",
      "root",
    );
    assert.deepEqual(asked.doc, {
      ok: true,
      url: printed.stdout.trim(),
      worktree: "alpha",
    });
  });
});

describe("projects relocate", () => {
  it("points a project at its moved repo, as the Go sm did", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    await box.migrate("cli");
    const usage = await runAt(box.home, "projects", "relocate");
    assert.equal(usage.code, 2);
    assert.equal(
      usage.stderr,
      "smd: Usage: smd projects relocate [<name-or-path>] <new-path>\n",
    );
    const stillThere = await runAt(
      box.home,
      "projects",
      "relocate",
      "alpha",
      beta,
    );
    assert.equal(stillThere.code, 1);
    assert.equal(
      stillThere.stderr,
      `smd: ${alpha} is still there. Relocate is for a repo that was moved or renamed by hand.\n`,
    );
    // What is kept under the primary's id follows it to the new one.
    const titled = await runAt(alpha, "worktrees", "describe", "-t", "Main");
    assert.equal(titled.code, 0, titled.stderr);
    const moved = join(box.home, "gamma");
    renameSync(alpha, moved);
    const relocated = await runAt(
      box.home,
      "projects",
      "relocate",
      "alpha",
      moved,
    );
    assert.equal(relocated.code, 0, relocated.stderr);
    assert.equal(relocated.stdout, `relocated gamma to ${moved}\n`);
    const again = await runAt(
      box.home,
      "--json",
      "projects",
      "relocate",
      "--project-id",
      "A",
      moved,
    );
    const doc = again.doc as {
      ok: boolean;
      project: { id: string; path: string };
    };
    assert.equal(doc.ok, true);
    assert.equal(doc.project.id, "A");
    assert.equal(doc.project.path, moved);
    const title = await runAt(moved, "--json", "worktrees", "describe");
    assert.equal((title.doc as { title: string }).title, "Main");
  });
});

describe("projects relocate, asked again", () => {
  it("carries a linked worktree's title when git already re-linked it, as after a relocate a crash cut short", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const layout = await runAt(
      alpha,
      "projects",
      "config",
      "set",
      "worktreeLayout",
      "in-project",
    );
    assert.equal(layout.code, 0, layout.stderr);
    const made = await runAt(alpha, "--json", "worktrees", "create", "fox");
    assert.equal(made.code, 0, made.stderr);
    const fox = (made.doc as { worktree: { path: string } }).worktree.path;
    const titled = await runAt(fox, "worktrees", "describe", "-t", "Fox");
    assert.equal(titled.code, 0, titled.stderr);
    const moved = join(box.home, "gamma");
    renameSync(alpha, moved);
    // The repair a relocate runs first, as if it then crashed.
    box.git(
      moved,
      "worktree",
      "repair",
      join(moved, fox.slice(alpha.length + 1)),
    );
    const relocated = await runAt(
      box.home,
      "projects",
      "relocate",
      "alpha",
      moved,
    );
    assert.equal(relocated.code, 0, relocated.stderr);
    const title = await runAt(
      join(moved, fox.slice(alpha.length + 1)),
      "--json",
      "worktrees",
      "describe",
    );
    assert.equal((title.doc as { title: string }).title, "Fox");
  });
});

describe("worktrees rename", () => {
  it("moves the folder to its new name, and refuses what create would", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    const base = join(box.side("cli"), "wt", "alpha");
    for (const name of ["fox", "owl"]) {
      box.git(alpha, "worktree", "add", "-q", "-b", name, join(base, name));
    }
    await box.migrate("cli");
    const usage = await runAt(box.home, "worktrees", "rename");
    assert.equal(usage.code, 2);
    assert.equal(
      usage.stderr,
      "smd: Usage: smd worktrees rename [<name>] <new-name>\n",
    );
    const renamed = await runAt(
      box.home,
      "wt",
      "rename",
      "-p",
      "alpha",
      "fox",
      "otter",
    );
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.equal(renamed.stdout, `${join(base, "otter")}\n`);
    const again = await runAt(
      box.home,
      "--json",
      "worktrees",
      "rename",
      "-p",
      "alpha",
      "otter",
      "badger",
    );
    const doc = again.doc as {
      ok: boolean;
      worktree: { id: string; name: string; path: string };
      previousId: string;
    };
    assert.equal(doc.ok, true);
    assert.equal(doc.worktree.name, "badger");
    assert.equal(doc.worktree.path, join(base, "badger"));
    assert.notEqual(doc.previousId, doc.worktree.id);
    const taken = await runAt(
      box.home,
      "worktrees",
      "rename",
      "-p",
      "alpha",
      "badger",
      "OWL",
    );
    assert.equal(taken.code, 1);
    assert.equal(
      taken.stderr,
      'smd: A worktree folder named "OWL" already exists in this project.\n',
    );
    const primary = await runAt(
      box.home,
      "worktrees",
      "rename",
      "-p",
      "alpha",
      "root",
      "x",
    );
    assert.equal(primary.code, 1);
    assert.equal(
      primary.stderr,
      "smd: The primary checkout keeps its folder's name\n",
    );
    assert.equal(
      (
        await runAt(
          box.home,
          "worktrees",
          "rename",
          "-p",
          "alpha",
          "owl",
          "a/b",
        )
      ).code,
      2,
    );
  });
});

// The Go sm's parser (cli/args.go), ahead of effect/cli's.
describe("the Go sm's command line", () => {
  // Projects alpha and beta, alpha with a managed worktree fox.
  const fixture = async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    const fox = join(box.side("cli"), "wt", "alpha", "fox");
    box.git(alpha, "worktree", "add", "-q", "-b", "fox", fox);
    await box.migrate("cli");
    return { alpha, beta, fox };
  };
  const described = async () =>
    (await runAt(box.home, "--json", "describe", "-p", "alpha", "fox")).doc as {
      readonly title: string;
      readonly description: string;
    };

  it("lists past a store another process is writing, and says the store is busy when it must write", async () => {
    await fixture();
    // The store made and imported, as the app made it.
    assert.equal((await described()).title, "");
    // The app mid-write: the store's write lock held.
    const holder = new DatabaseSync(join(box.side("cli"), "store.db"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const listed = await runAt(box.home, "--json", "list", "-p", "alpha");
      assert.equal(listed.code, 0, listed.stderr);
      const set = await runAt(
        box.home,
        "--json",
        "describe",
        "-p",
        "alpha",
        "fox",
        "-t",
        "Fox",
      );
      assert.equal(set.code, 1, set.stderr);
      assert.deepEqual(set.doc, {
        ok: false,
        error:
          "The store is busy: the app or another command is writing to it. Try again in a moment.",
        code: "store-busy",
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  }, 30_000);

  it("takes a long flag after a single dash", async () => {
    await fixture();
    const set = await runAt(
      box.home,
      "describe",
      "-project",
      "alpha",
      "fox",
      "-title",
      "Fox",
    );
    assert.equal(set.code, 0, set.stderr);
    assert.equal((await described()).title, "Fox");
  });

  it("gives a valued flag the next argument, a dash and all", async () => {
    await fixture();
    const set = await runAt(
      box.home,
      "describe",
      "-p",
      "alpha",
      "fox",
      "-d",
      "- item one",
    );
    assert.equal(set.code, 0, set.stderr);
    assert.equal((await described()).description, "- item one");
  });

  it("keeps the last of a repeated flag", async () => {
    await fixture();
    const listed = await runAt(
      box.home,
      "--json",
      "projects",
      "config",
      "list",
      "-p",
      "beta",
      "-p",
      "alpha",
    );
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal((listed.doc as { project: string }).project, "alpha");
  });

  it("refuses a value for a bare flag, and never takes the next one", async () => {
    const { alpha } = await fixture();
    const valued = await runAt(box.home, "list", "--all=1");
    assert.equal(valued.code, 2);
    assert.equal(valued.stderr, 'smd: Option "--all=1" takes no value.\n');
    // `false` is a positional, which list lets be, so --all stands.
    const all = await runAt(alpha, "--json", "list", "--all", "false");
    assert.equal(all.code, 0, all.stderr);
    assert.equal((all.doc as ReadonlyArray<unknown>).length, 3);
  });

  it("names a mistyped verb as Go's dispatchers did, flags or not", async () => {
    const projects =
      "Usage: smd projects <list|icon|add|remove|relocate|reorder|config> [args]";
    const refusals: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["projects", "ad", "--all"], `Unknown subcommand "ad". ${projects}`],
      [
        ["projects", "bogus", "--", "-x"],
        `Unknown subcommand "bogus". ${projects}`,
      ],
      [
        ["agents", "--harness", "claude", "status"],
        'Unknown subcommand "--harness". Usage: smd agents <install|uninstall|status|bind|unbind|idle|resume|event> [args]',
      ],
      [
        ["config", "lst", "--data", "x"],
        'Unknown subcommand "lst". Usage: smd config <list|read|get|set|unset|launcher|edit> [args]',
      ],
      [
        ["projects", "config", "lst"],
        'Unknown subcommand "lst". Usage: smd projects config <list|get|set|unset|edit|read|launcher|carryover> [args]',
      ],
      // The config namespaces parsed every flag first.
      [["config", "lst", "--bogus"], 'Unknown option "--bogus".'],
    ];
    const runs = await Promise.all(
      refusals.map(([args]) => start(box.home, args).ended),
    );
    runs.forEach((run, i) => {
      const [args, said] = refusals[i] as (typeof refusals)[number];
      assert.equal(run.code, 2, args.join(" "));
      assert.equal(run.stderr, `smd: ${said}\n`, args.join(" "));
    });
    // So a config verb's flag may come before the verb.
    box.write("registry.json", { projects: [] });
    await box.migrate("cli");
    const written = await runAt(
      box.home,
      "config",
      "--data",
      '{"launchScripts": false}',
      "write",
    );
    assert.equal(written.code, 0, written.stderr);
    const got = await runAt(box.home, "config", "get", "launchScripts");
    assert.equal(got.stdout, "false\n");
  });

  it("hands `wt` a flag before the name, as switch's", async () => {
    const { fox } = await fixture();
    const cdFile = join(box.home, "cd");
    writeFileSync(cdFile, "");
    const ended = await start(box.home, ["wt", "-p", "alpha", "fox"], {
      SHIGOMORI_CD_FILE: cdFile,
    }).ended;
    assert.equal(ended.code, 0, ended.stderr);
    assert.equal(readFileSync(cdFile, "utf8"), `${fox}\n`);
  });

  it("lets be the positionals a verb doesn't read, where Go did", async () => {
    const { alpha, fox } = await fixture();
    const gamma = box.repo("gamma");
    const cdFile = join(box.home, "cd");
    for (const args of [
      ["cd", "fox", "extra"],
      ["wt", "fox", "extra"],
    ]) {
      writeFileSync(cdFile, "");
      const ended = await start(alpha, args, {
        SHIGOMORI_CD_FILE: cdFile,
      }).ended;
      assert.equal(ended.code, 0, `${args.join(" ")}: ${ended.stderr}`);
      assert.equal(readFileSync(cdFile, "utf8"), `${fox}\n`);
    }
    for (const args of [
      ["launchers", "list", "extra"],
      ["projects", "list", "foo"],
      ["config", "list", "extra"],
      ["projects", "icon", "alpha", "extra"],
      ["projects", "add", gamma, "extra"],
      ["projects", "remove", "beta", "extra", "--yes"],
    ]) {
      const run = await runAt(alpha, ...args);
      assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
    }
    // Go refused these.
    assert.equal((await runAt(alpha, "config", "get", "a", "b")).code, 2);
    assert.equal((await runAt(alpha, "mirrors", "extra")).code, 2);
  });

  it("tells a lifecycle script truecolor only under --json", async () => {
    await fixture();
    const configured = await runAt(
      box.home,
      "projects",
      "config",
      "-p",
      "alpha",
      "--setup",
      'echo "colorterm=$COLORTERM"',
    );
    assert.equal(configured.code, 0, configured.stderr);
    const json = await runAt(box.home, "--json", "setup", "-p", "alpha", "fox");
    assert.equal(json.code, 0, json.stderr);
    assert.match(json.stdout, /colorterm=truecolor/);
    const person = await runAt(box.home, "setup", "-p", "alpha", "fox");
    assert.equal(person.code, 0, person.stderr);
    assert.match(person.stderr, /colorterm=\n/);
  });

  it("binds the calling session on every command that reads where it runs", async () => {
    const { fox } = await fixture();
    for (const verb of ["mirrors", "bundle"]) {
      const session = `session-${verb}`;
      await start(fox, [verb], { CLAUDE_CODE_SESSION_ID: session }).ended;
      const unbound = await start(fox, [
        "--json",
        "agents",
        "unbind",
        "--harness",
        "claude",
        "--session",
        session,
      ]).ended;
      assert.deepEqual(lastDoc(unbound.stdout), { ok: true, unbound: true });
    }
  });

  it("says terrier's trouble once when an agent session lists the projects", async () => {
    const { alpha } = await fixture();
    box.fakeBin("terrier", "exit 1");
    assert.equal(
      (await runAt(box.home, "config", "set", "terrier", "true")).code,
      0,
    );
    const listed = await start(alpha, ["projects", "list"], {
      CLAUDE_CODE_SESSION_ID: "session",
    }).ended;
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stderr.match(/warning:/g)?.length, 1, listed.stderr);
  });
});

describe("describe with an open pull request", () => {
  // A worktree fox of a project cloned from an upstream, and a gh that
  // finds fox's open PR #7 unless `mode` says it fails: "remote" as for
  // a repo off GitHub, "auth" signed out, "down" GitHub erroring.
  const project = async () => {
    const upstream = box.repo("upstream", { "README.md": "hi\n" });
    const repo = join(box.home, "repo");
    box.git(box.home, "clone", "-q", upstream, repo);
    box.write("registry.json", {
      projects: [{ id: "R", name: "repo", path: repo }],
    });
    const fox = join(box.side("cli"), "wt", "repo", "fox");
    box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
    await box.migrate("cli");
    const log = join(box.home, "gh.log");
    const mode = join(box.home, "gh.mode");
    box.fakeBin(
      "gh",
      `echo "$*" >> '${log}'
case "$(cat '${mode}' 2>/dev/null)" in
  remote) echo "none of the git remotes configured for this repository point to a known GitHub host" >&2; exit 1;;
  auth) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 1;;
  down) echo "HTTP 502: Bad Gateway" >&2; exit 1;;
esac
case "$*" in
  "pr list --state open --head fox "*) echo '[{"number":7,"url":"u7","title":"Fox","body":"","isCrossRepository":false}]';;
  "pr edit "*) ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    );
    const described = (...args: string[]) =>
      runAt(box.home, "describe", "-p", "repo", "fox", ...args);
    const own = async () =>
      (await runAt(box.home, "--json", "describe", "-p", "repo", "fox"))
        .doc as { readonly title: string; readonly description: string };
    const calls = () => readFileSync(log, "utf8").split("\n");
    return { described, own, calls, mode };
  };

  it("edits the PR and leaves the worktree's own pair as it was", async () => {
    const { described, own, calls, mode } = await project();
    writeFileSync(mode, "remote");
    assert.equal((await described("-t", "Before the PR")).code, 0);
    writeFileSync(mode, "");

    const edited = await described("-t", "Foxes", "-d", "- What they do.");
    assert.equal(edited.code, 0, edited.stderr);
    assert.equal(edited.stdout, "edited PR #7: Foxes\n");
    assert.equal((await described("-d", "")).code, 0);
    const json = await runAt(
      box.home,
      "--json",
      "describe",
      "-p",
      "repo",
      "fox",
      "-t",
      "Fox",
    );
    assert.equal(
      (json.doc as { pullRequest: { number: number; title: string } })
        .pullRequest.title,
      "Fox",
    );
    for (const call of [
      "pr edit 7 --title=Foxes --body=- What they do.",
      "pr edit 7 --body=",
    ]) {
      assert.ok(calls().includes(call), calls().join("\n"));
    }
    assert.deepEqual(await own(), {
      ok: true,
      title: "Before the PR",
      description: "",
      pullRequest: {
        number: 7,
        url: "u7",
        title: "Fox",
        body: "",
        isCrossRepository: false,
      },
    });

    // A PR's title can't be cleared.
    assert.equal((await described("-t", "")).code, 2);
  });

  it("changes nothing when gh can't tell, and writes its own when gh is signed out", async () => {
    const { described, own, mode } = await project();
    writeFileSync(mode, "down");
    const down = await described("-t", "Lost");
    assert.equal(down.code, 1);
    assert.match(
      down.stderr,
      /Couldn't check for a pull request \(HTTP 502: Bad Gateway\), so nothing was changed\./,
    );
    writeFileSync(mode, "remote");
    assert.equal((await own()).title, "");

    // gh signed out can't show a PR anywhere, the app's included.
    writeFileSync(mode, "auth");
    const signedOut = await described("-t", "Signed out");
    assert.equal(signedOut.code, 0, signedOut.stderr);
    assert.match(
      signedOut.stderr,
      /Couldn't check for a pull request \(gh isn't authenticated\)\./,
    );
    writeFileSync(mode, "remote");
    assert.equal((await own()).title, "Signed out");
  });
});

describe("disk-usage", () => {
  it("measures a folder, stepping over what --exclude names", async () => {
    const dir = join(box.home, "measured");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "x".repeat(100_000));
    writeFileSync(join(dir, "nested", "b.txt"), "y".repeat(100_000));
    const whole = await runAt(box.home, "--json", "disk-usage", dir);
    assert.equal(whole.code, 0, whole.stderr);
    const doc = whole.doc as Record<string, unknown>;
    assert.deepEqual(Object.keys(doc), [
      "bytes",
      "reclaimableBytes",
      "lastActivityAt",
      "partial",
    ]);
    assert.equal(doc["partial"], false);
    assert.equal(typeof doc["lastActivityAt"], "number");
    const part = await runAt(
      box.home,
      "--json",
      "disk-usage",
      "measured",
      "--exclude",
      "measured/nested",
    );
    assert.ok(
      (part.doc as { bytes: number }).bytes < (doc["bytes"] as number),
      part.stdout,
    );
    const person = await runAt(box.home, "disk-usage", dir);
    assert.match(person.stdout, /^\d+ bytes on disk, \d+ reclaimable\n$/);
    const usage = await runAt(box.home, "disk-usage");
    assert.equal(usage.code, 2);
    assert.equal(
      usage.stderr,
      "smd: Usage: smd disk-usage <path> [--exclude <path>...]\n",
    );
  });
});

// A PR as gh lists it.
const pr = (
  number: number,
  head: string,
  base: string,
  state: string,
  more: Record<string, unknown> = {},
) =>
  JSON.stringify({
    number,
    title: head === "fox" ? "Fox" : "Bear",
    state,
    isDraft: false,
    url: `u${number}`,
    baseRefName: base,
    headRefName: head,
    isCrossRepository: false,
    ...more,
  });

// A PR's merge progress in `state`, nothing armed or queued.
const prState = (value: string) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: value,
          mergeStateStatus: value === "MERGED" ? "CLEAN" : "BLOCKED",
        },
      },
    },
  });

const settings = (autoMerge: boolean) =>
  JSON.stringify({
    data: {
      repository: {
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        autoMergeAllowed: autoMerge,
      },
    },
  });

// PR #5's progress, as each read finds it.
const progress = (state: string, armed: boolean) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state,
          mergeStateStatus: state === "MERGED" ? "CLEAN" : "BLOCKED",
          ...(armed ? { autoMergeRequest: { mergeMethod: "SQUASH" } } : {}),
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          name: "ci",
                          status: "IN_PROGRESS",
                          conclusion: "",
                          isRequired: true,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

// merge, land and rm --stack as a person reads them, against a scripted
// gh: what is said, and when.
describe("landing", () => {
  // A project cloned from an upstream, with a managed worktree fox a
  // commit ahead on its own branch.
  const project = async () => {
    const upstream = box.repo("upstream", { "README.md": "hi\n" });
    const repo = join(box.home, "repo");
    box.git(box.home, "clone", "-q", upstream, repo);
    box.write("registry.json", {
      projects: [{ id: "R", name: "repo", path: repo }],
    });
    const fox = join(box.side("cli"), "wt", "repo", "fox");
    box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
    box.git(fox, "commit", "-q", "--allow-empty", "-m", "fox");
    await box.migrate("cli");
    return { repo, fox };
  };

  // gh answering each call whose arguments match a pattern with its
  // answer, and any other call refused.
  const fakeGh = (answers: ReadonlyArray<readonly [string, string]>) =>
    box.fakeBin(
      "gh",
      `case "$*" in
${answers.map(([pattern, answer]) => `  ${pattern}) cat <<'ANSWER'\n${answer}\nANSWER\n  ;;`).join("\n")}
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    );

  it("says the merge and the catch-up before the cleanup, which may fail", async () => {
    const { fox } = await project();
    fakeGh([
      [
        '"pr list --state all --head fox "*',
        `[${pr(5, "fox", "main", "OPEN", { mergeStateStatus: "CLEAN" })}]`,
      ],
      [
        '"pr view 5 --json headRefOid"',
        JSON.stringify({
          headRefOid: box.git(fox, "rev-parse", "HEAD").trim(),
        }),
      ],
      ['"api graphql -F number=5 "*', progress("MERGED", false)],
      ['"api graphql "*', settings(false)],
      ['"pr merge 5 --squash"', ""],
    ]);
    const configured = await runAt(
      box.home,
      "projects",
      "config",
      "-p",
      "repo",
      "--teardown",
      "exit 1",
    );
    assert.equal(configured.code, 0, configured.stderr);
    const landed = await runAt(box.home, "land", "-p", "repo", "fox");
    assert.equal(landed.code, 1, landed.stderr);
    assert.equal(landed.stdout, "merged PR #5 (squash): Fox\n");
    const caught = landed.stderr.indexOf(
      "primary checkout caught up (origin/main)",
    );
    assert.ok(caught !== -1, landed.stderr);
    assert.ok(
      landed.stderr.endsWith(
        "smd: teardown exited with code 1; worktree not removed\n",
      ),
      landed.stderr,
    );
  });

  // A stack whose top layer, fox, merged at PR #5's head (the commit
  // fox is on now) onto bear, itself merged.
  const landedStack = (fox: string) =>
    fakeGh([
      [
        '"pr list --state all --head fox "*',
        `[${pr(5, "fox", "bear", "MERGED")}]`,
      ],
      [
        '"pr list --state all --limit 200 "*',
        `[${pr(4, "bear", "main", "MERGED")},${pr(5, "fox", "bear", "MERGED")}]`,
      ],
      [
        '"pr view 5 --json headRefOid"',
        JSON.stringify({
          headRefOid: box.git(fox, "rev-parse", "HEAD").trim(),
        }),
      ],
    ]);

  it("says where rm --stack leaves a primary checkout on a landed branch", async () => {
    const { repo, fox } = await project();
    box.git(repo, "checkout", "-q", "-b", "bear");
    landedStack(fox);
    const removed = await runAt(box.home, "rm", "--stack", "-p", "repo", "fox");
    assert.equal(removed.code, 0, removed.stderr);
    assert.ok(
      removed.stderr.includes(
        "the primary checkout is on landed branch bear. `smd done` lands it back on main\n",
      ),
      removed.stderr,
    );
  });

  it("refuses an rm --stack whose branch has a commit its merged PR never had", async () => {
    const { repo, fox } = await project();
    box.git(repo, "checkout", "-q", "-b", "bear");
    landedStack(fox);
    box.git(fox, "commit", "-q", "--allow-empty", "-m", "late");
    const removed = await runAt(box.home, "rm", "--stack", "-p", "repo", "fox");
    assert.equal(removed.code, 1, removed.stderr);
    assert.match(
      removed.stderr,
      /Branch fox has a commit its merged PR #5 never had, which removing it would delete: [0-9a-f]+ late\./,
    );
    assert.ok(existsSync(fox), "the worktree stays");
  });

  it("says when a merge queue takes a stack, under --json too", async () => {
    await project();
    fakeGh([
      [
        '"pr list --state all --head fox "*',
        `[${pr(5, "fox", "bear", "OPEN", { mergeStateStatus: "CLEAN" })}]`,
      ],
      [
        '"pr list --state all --limit 200 "*',
        `[${pr(4, "bear", "main", "OPEN")},${pr(5, "fox", "bear", "OPEN")}]`,
      ],
      [
        '"api repos/{owner}/{repo}/stacks?pull_request=5"',
        '[{"pull_requests":[{"number":4,"state":"open"},{"number":5,"state":"open"}]}]',
      ],
      ['"api graphql "*', settings(false)],
      [
        '"api -X PUT repos/{owner}/{repo}/pulls/5/merge-async "*',
        '{"status":"enqueued","details":{"message":"","uuid":"t"}}',
      ],
    ]);
    const merged = await runAt(
      box.home,
      "--json",
      "merge",
      "--stack",
      "-p",
      "repo",
      "fox",
    );
    assert.equal(merged.code, 0, merged.stderr);
    assert.deepEqual(merged.doc, {
      ok: true,
      method: "squash",
      outcome: "queued",
    });
    assert.equal(
      merged.stderr.split("\n").at(-2),
      "the stack is in the merge queue; it lands when the queue processes it",
      merged.stderr,
    );
  });

  it("checks a stack land's branch again after the merge, and keeps a commit made while it waited", async () => {
    const { fox } = await project();
    const head = box.git(fox, "rev-parse", "HEAD").trim();
    // gh merging the stack is when the commit lands: work made while
    // GitHub took its time.
    box.fakeBin(
      "gh",
      `case "$*" in
  "pr list --state all --head fox "*) cat <<'ANSWER'
[${pr(5, "fox", "bear", "OPEN", { mergeStateStatus: "CLEAN" })}]
ANSWER
  ;;
  "pr list --state all --limit 200 "*) cat <<'ANSWER'
[${pr(4, "bear", "main", "OPEN")},${pr(5, "fox", "bear", "OPEN")}]
ANSWER
  ;;
  "api repos/{owner}/{repo}/stacks?pull_request=5") echo '[{"pull_requests":[{"number":4,"state":"open"},{"number":5,"state":"open"}]}]';;
  "api graphql "*) cat <<'ANSWER'
${settings(false)}
ANSWER
  ;;
  "pr view 5 --json headRefOid") echo '{"headRefOid":"${head}"}';;
  "api -X PUT repos/{owner}/{repo}/pulls/5/merge-async "*)
    git -C '${fox}' commit -q --allow-empty -m late
    echo '{"status":"merged","details":{"message":"","uuid":"t"}}';;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    );
    const landed = await runAt(
      box.home,
      "land",
      "--stack",
      "-p",
      "repo",
      "fox",
    );
    assert.equal(landed.code, 1, landed.stderr);
    assert.match(
      landed.stderr,
      /Branch fox has a commit its merged PR #5 never had, which removing it would delete: [0-9a-f]+ late\./,
    );
    assert.ok(existsSync(fox), "the worktree stays");
  });

  it("stops a stack land at a layer a merge queue only queued, with nothing above merged or removed", async () => {
    const { fox } = await project();
    const log = join(box.home, "gh.log");
    const queued = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            isInMergeQueue: true,
          },
        },
      },
    });
    box.fakeBin(
      "gh",
      `echo "$*" >> '${log}'
case "$*" in
  "pr list --state all --head fox "*) cat <<'ANSWER'
[${pr(5, "fox", "bear", "OPEN", { mergeStateStatus: "CLEAN" })}]
ANSWER
  ;;
  "pr list --state all --limit 200 "*) cat <<'ANSWER'
[${pr(4, "bear", "main", "OPEN")},${pr(5, "fox", "bear", "OPEN")}]
ANSWER
  ;;
  "api repos/{owner}/{repo}/stacks?pull_request=5") echo "gh: Not Found (HTTP 404)" >&2; exit 1;;
  "api graphql -F number=4 "*) cat <<'ANSWER'
${queued}
ANSWER
  ;;
  "api graphql "*) cat <<'ANSWER'
${settings(false)}
ANSWER
  ;;
  "pr view 5 --json headRefOid") echo '{"headRefOid":"${box.git(fox, "rev-parse", "HEAD").trim()}"}';;
  "pr merge 4 --squash") ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    );
    const landed = await runAt(
      box.home,
      "land",
      "--stack",
      "-p",
      "repo",
      "fox",
    );
    assert.equal(landed.code, 0, landed.stderr);
    assert.match(
      landed.stderr,
      /PR #4 is in the merge queue; land again once it merges, for the rest of the stack/,
    );
    const calls = readFileSync(log, "utf8");
    assert.ok(!calls.includes("pr edit 5"), calls);
    assert.ok(!calls.includes("pr merge 5"), calls);
    assert.ok(existsSync(fox), "nothing removed");
  });

  it("waits out GitHub's lag after a layer's merge before deciding the rest of a stack land", async () => {
    const { fox } = await project();
    const log = join(box.home, "gh.log");
    const reads = join(box.home, "reads-4");
    box.fakeBin(
      "gh",
      `echo "$*" >> '${log}'
case "$*" in
  "pr list --state all --head fox "*) cat <<'ANSWER'
[${pr(5, "fox", "bear", "OPEN", { mergeStateStatus: "CLEAN" })}]
ANSWER
  ;;
  "pr list --state all --limit 200 "*) cat <<'ANSWER'
[${pr(4, "bear", "main", "OPEN")},${pr(5, "fox", "bear", "OPEN")}]
ANSWER
  ;;
  "api repos/{owner}/{repo}/stacks?pull_request=5") echo "gh: Not Found (HTTP 404)" >&2; exit 1;;
  "api graphql -F number=4 "*)
    # Still open on the first read after the merge, merged after.
    if [ -e '${reads}' ]; then cat <<'ANSWER'
${prState("MERGED")}
ANSWER
    else touch '${reads}'; cat <<'ANSWER'
${prState("OPEN")}
ANSWER
    fi;;
  "api graphql -F number=5 "*) cat <<'ANSWER'
${prState("MERGED")}
ANSWER
  ;;
  "api graphql "*) cat <<'ANSWER'
${settings(false)}
ANSWER
  ;;
  "pr view 5 --json headRefOid") echo '{"headRefOid":"${box.git(fox, "rev-parse", "HEAD").trim()}"}';;
  "pr merge 4 --squash"|"pr merge 5 --squash") ;;
  "pr edit 5 --base main") ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    );
    await runAt(box.home, "land", "--stack", "-p", "repo", "fox");
    const calls = readFileSync(log, "utf8");
    assert.ok(calls.includes("pr merge 5 --squash"), calls);
  });

  it("finishes done on the primary checkout when its pull fails, and says so", async () => {
    const { repo } = await project();
    box.git(repo, "checkout", "-q", "-b", "bear");
    // The remote out of reach for the pull.
    box.git(repo, "remote", "set-url", "origin", join(box.home, "gone.git"));
    const done = await runAt(box.home, "done", "-p", "repo", "repo");
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /is now on main \(deleted branch bear\)/);
    assert.match(done.stderr, /skipped catch-up: /);
    assert.equal(box.git(repo, "branch", "--list", "bear").trim(), "");
  });

  it("says an auto-merge by number was already armed", async () => {
    await project();
    fakeGh([
      [
        '"pr view 5 --json "*',
        pr(5, "fox", "main", "OPEN", {
          mergeStateStatus: "BLOCKED",
          autoMergeRequest: { mergeMethod: "SQUASH" },
        }),
      ],
      ['"api graphql "*', settings(true)],
    ]);
    const merged = await runAt(
      box.home,
      "merge",
      "--number",
      "5",
      "-p",
      "repo",
    );
    assert.equal(merged.code, 0, merged.stderr);
    assert.equal(
      merged.stdout,
      "auto-merge already enabled for PR #5 (squash): Fox\n",
    );
  });

  it("says what a merge waits on, under --json too", async () => {
    await project();
    fakeGh([
      [
        '"pr list --state all --head fox "*',
        `[${pr(5, "fox", "main", "OPEN", { mergeStateStatus: "BLOCKED" })}]`,
      ],
      ['"api graphql -F number=5 "*', progress("OPEN", true)],
      ['"api graphql "*', settings(true)],
      ['"pr merge 5 --auto --squash"', ""],
    ]);
    const { child, ended } = start(box.home, [
      "--json",
      "merge",
      "-p",
      "repo",
      "fox",
    ]);
    // The wait goes on until GitHub merges it, so it ends here.
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => (said += chunk));
    await vi
      .waitFor(
        () =>
          assert.equal(
            said.split("\n").at(-2),
            "waiting for GitHub to merge it: checks are running",
            said,
          ),
        { timeout: 15_000, interval: 100 },
      )
      .finally(() => child.kill());
    await ended;
  });
});

describe("a data-folder move under way", () => {
  // The move holds the lock alone, as the app's does: a change on disk,
  // the doctor's repairs among them, is refused before it starts, and a
  // read still answers.
  it("refuses a change on disk while a move holds the lock, and reads on", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const made = await runAt(alpha, "--json", "worktrees", "create", "fox");
    assert.equal(made.code, 0, made.stderr);
    const fox = (made.doc as { worktree: { path: string } }).worktree.path;
    const lockFile = join(
      box.home,
      ".config",
      flavorNames("dev").configDir,
      "data-dir.lock",
    );
    mkdirSync(dirname(lockFile), { recursive: true });
    const move = new DatabaseSync(lockFile);
    move.exec("PRAGMA locking_mode = EXCLUSIVE");
    move.exec("CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY)");
    move.exec("INSERT OR REPLACE INTO held (id) VALUES (1)");
    try {
      const removed = await runAt(alpha, "rm", "fox");
      assert.notEqual(removed.code, 0);
      assert.match(removed.stderr, /The data folder is being moved/);
      const created = await runAt(alpha, "worktrees", "create", "owl");
      assert.match(created.stderr, /The data folder is being moved/);
      const fixed = await runAt(alpha, "doctor", "--fix", "--yes");
      assert.match(fixed.stderr, /The data folder is being moved/);
      const listed = await runAt(alpha, "--json", "list");
      assert.equal(listed.code, 0, listed.stderr);
    } finally {
      move.close();
    }
    assert.ok(existsSync(fox));
    const after = await runAt(alpha, "rm", "fox");
    assert.equal(after.code, 0, after.stderr);
  });

  // A lock file that isn't a lock database refuses every move, and lets
  // a change run, under Bun's SQLite as under node's.
  it("runs a change on disk when the lock file isn't a database", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const lockFile = join(
      box.home,
      ".config",
      flavorNames("dev").configDir,
      "data-dir.lock",
    );
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, "x".repeat(4096));
    const made = await runAt(alpha, "--json", "worktrees", "create", "fox");
    assert.equal(made.code, 0, made.stderr);
    const removed = await runAt(alpha, "rm", "fox");
    assert.equal(removed.code, 0, removed.stderr);
  });
});

describe("projects config", () => {
  it("writes nothing for a refused launcher rm or carryover rm: no default branch seeded", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    for (const verb of [
      ["launcher", "rm", "nosuch"],
      ["carryover", "rm", "nosuch"],
    ]) {
      const refused = await runAt(alpha, "projects", "config", ...verb);
      assert.equal(refused.code, 1, refused.stderr);
      const stored = await runAt(alpha, "--json", "projects", "config");
      assert.equal(
        stored.stdout.trim(),
        "null",
        `a refused ${verb.join(" ")} wrote`,
      );
    }
  });
});

describe("a setup that leaves a child in the background", () => {
  // The project, its setup `(sleep 60; echo late) &`, which writes the
  // child's pid and its sleep's where the proof ends them.
  const backgrounded = async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
    await box.migrate("cli");
    const pidFile = join(box.home, "late.pid");
    const set = await runAt(
      alpha,
      "projects",
      "config",
      "--setup",
      `(sleep 60 & echo $! > "${pidFile}.sleep"; wait; echo late) & echo $! > "${pidFile}"`,
    );
    assert.equal(set.code, 0, set.stderr);
    const endChild = () => {
      for (const file of [pidFile, `${pidFile}.sleep`]) {
        try {
          process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
        } catch {
          // Not started, or gone.
        }
      }
    };
    return { alpha, pidFile, endChild };
  };

  it("ends the create at the setup's exit, the child still running", async () => {
    const { alpha, pidFile, endChild } = await backgrounded();
    try {
      const began = performance.now();
      const made = await runAt(alpha, "--json", "worktrees", "create", "fox");
      assert.equal(made.code, 0, made.stderr);
      assert.ok(performance.now() - began < 30_000, "held by the child");
      const pid = Number(readFileSync(pidFile, "utf8"));
      process.kill(pid, 0);
    } finally {
      endChild();
    }
  }, 60_000);

  it("returns a terminal's prompt with the shell in the new worktree", async () => {
    const { alpha, endChild } = await backgrounded();
    // An interactive zsh with the shell integration, in a terminal of
    // its own, typed into as a person types.
    const zdot = join(box.home, "zdot");
    mkdirSync(zdot, { recursive: true });
    writeFileSync(
      join(zdot, ".zshrc"),
      `PS1='ready> '\neval "$(smd shell init zsh)"\n`,
    );
    const child = spawn("sh", ["-c", "cat | script -q /dev/null zsh -i"], {
      cwd: alpha,
      env: {
        ...box.env("cli"),
        PATH: `${dirname(built)}:${process.env["PATH"] ?? ""}`,
        ZDOTDIR: zdot,
        HISTFILE: join(zdot, "history"),
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    let screen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      screen += chunk.toString();
    });
    try {
      child.stdin.write("smd worktrees create fox\n");
      child.stdin.write('echo "now-in=$PWD"\n');
      const deadline = performance.now() + 30_000;
      while (!/now-in=\S+fox\r?\n/.test(screen)) {
        assert.ok(
          performance.now() < deadline,
          `the prompt never came back:\n${screen}`,
        );
        await sleep(100);
      }
      assert.match(screen, /now-in=\S*\/fox\r?\n/);
    } finally {
      endChild();
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Gone.
        }
      }
    }
  }, 60_000);
});
