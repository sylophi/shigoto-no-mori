// The terminal binary, built as it ships, on a sandbox data dir: what
// the engine's tests can't see from a service call. How a command line
// is refused, a person at a terminal, the shell's config and wrapper,
// and a script handed the terminal, its signals and its ending.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "vitest";
import { macfs, type Sandbox, sandbox } from "../../engine/test/lib/sandbox.ts";
import {
  type FakeApp,
  fakeApp,
  refusal,
  success,
} from "../../engine/test/lib/fakeApp.ts";
import { flavorNames } from "@shigomori/engine/flavor";
import { documentedCommands } from "../src/help.ts";

let built: string;
let buildDir: string;
beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "sm-cli-"));
  built = join(buildDir, "smd");
  execFileSync(process.execPath, ["build.mts", built], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "ignore",
  });
  // The darwin helper beside the binary, as the app ships it.
  copyFileSync(macfs(), join(buildDir, "macfs"));
}, 300_000);
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

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

  it("refuses the variables the stand-in flags replaced", async () => {
    for (const name of [
      "SHIGOMORI_UPDATE_FEED_URL",
      "SHIGOMORI_UPDATE_RELEASES_URL",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one sandbox, one variable at a time
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

describe("at a terminal", () => {
  // The built binary in a terminal of its own (BSD script's pty), each
  // key typed once the screen shows the text paired with it: what it
  // showed, stdout and stderr together, escapes and all.
  const inTerminal = async (
    args: ReadonlyArray<string>,
    keys: ReadonlyArray<readonly [shown: string, key: string]>,
    env: NodeJS.ProcessEnv = {},
  ) => {
    // script takes no socket for its input, which node's pipes are, so
    // cat hands it a pipe.
    const command = 'cat | script -q /dev/null "$@"';
    const child = spawn("sh", ["-c", command, "sh", built, ...args], {
      cwd: box.home,
      env: { ...box.env("cli"), TERM: "xterm-256color", ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let shown = "";
    child.stdout.on("data", (chunk: Buffer) => (shown += chunk));
    const ended = new Promise((resolve) => child.on("close", resolve));
    const waitFor = async (
      text: string,
      from: number,
      deadline: number,
    ): Promise<void> => {
      if (shown.slice(from).includes(text)) return;
      if (Date.now() > deadline) {
        throw new Error(`Never showed ${text}:\n${shown}`);
      }
      await sleep(50);
      return waitFor(text, from, deadline);
    };
    const type = async (
      steps: ReadonlyArray<readonly [string, string]>,
    ): Promise<void> => {
      const [step, ...rest] = steps;
      if (step === undefined) return;
      await waitFor(step[0], shown.length, Date.now() + 10_000);
      // Past the frame, so the key lands in the menu that drew it.
      await sleep(150);
      child.stdin.write(step[1]);
      return type(rest);
    };
    try {
      await type(keys);
      child.stdin.end();
      await ended;
      return shown;
    } finally {
      child.kill();
    }
  };
  const DOWN = "\u001b[B";
  const HELP = "enter select";

  // Two projects, beta with a worktree "fox".
  const projects = () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.git(beta, "worktree", "add", "-q", "-b", "fox", `${box.home}/fox`);
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
  };

  it("picks a project, then one of its worktrees", async () => {
    projects();
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

  it("writes stderr as it is, with no color of Bun's", async () => {
    const shown = await inTerminal(["path", "nosuch"], []);
    // After script's echo of the end of input.
    assert.ok(
      shown.endsWith('\u001b[31msmd:\u001b[0m No worktree named "nosuch".\r\n'),
      JSON.stringify(shown),
    );
  });

  it("edits the settings in $EDITOR and saves what it left", async () => {
    box.write("registry.json", { projects: [] });
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

  it("filters by name, and esc cancels", async () => {
    projects();
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
});

describe("the v3 migration", () => {
  it("says one line per step at the first run, and nothing after", async () => {
    const repo = box.repo("repo", { "README.md": "hi\n" });
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
    });
    const v2 = join(box.side("cli"), "worktrees", "repo");
    for (const name of ["a", "b"]) {
      box.git(repo, "worktree", "add", "-q", "-b", name, join(v2, name));
    }
    box.git(repo, "worktree", "lock", join(v2, "b"));
    const first = await runAt(box.home, "--json", "list");
    assert.equal(first.code, 0, first.stderr);
    const name = flavorNames("dev").binaryName;
    assert.deepEqual(first.stderr.trimEnd().split("\n"), [
      "Imported the projects and settings from v2.",
      `Moved 1 of 2 worktrees into wt/; b (cannot move a locked working tree) stayed, for \`${name} doctor --fix\`.`,
    ]);
    const second = await runAt(box.home, "--json", "list");
    assert.equal(second.stderr, "");
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

const scripted = () => {
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
  return { repo, worktree };
};

describe("cd", () => {
  it("writes the worktree's path to the wrapper's directive file", async () => {
    const { repo, worktree } = scripted();
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
    const { repo, worktree } = scripted();
    for (const args of [
      ["worktrees", "switch", "w"],
      ["wt", "w"],
    ]) {
      const cdFile = join(box.home, "cd");
      writeFileSync(cdFile, "");
      // oxlint-disable-next-line no-await-in-loop -- one directive file, one run at a time
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
    const { repo, worktree } = scripted();
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
  it("ends as the script did", async () => {
    const { worktree } = scripted();
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
    const { repo } = scripted();
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

  // A signal sent to sm reaches the script, and sm ends as the script
  // did.
  it.each([
    ["SIGINT", "wait"],
    ["SIGTERM", "wait"],
    ["SIGTERM", "sleep"],
    ["SIGINT", "sleep"],
  ] as const)("passes %s on to the %s script", async (signal, script) => {
    const { worktree } = scripted();
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
});

describe("worktrees link", () => {
  it("prints the link that opens the worktree in the app, on this device", async () => {
    const alpha = box.repo("alpha");
    box.write("registry.json", {
      projects: [{ id: "A", name: "alpha", path: alpha }],
    });
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
    // The first run imports the 2.x files, and says so.
    await runAt(box.home, "--json", "list");
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
    // The first run imports the 2.x files, and says so.
    await runAt(box.home, "--json", "list");
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
