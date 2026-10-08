// The terminal binary, built as it ships, against the Go sm on copies
// of one sandbox: each verb's exit code, JSON document, output and
// errors. Under --json the documents must match (the CLI's surface is
// frozen, V3.md decision 13); a person's output too, where it's ours.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
import { goSm, type Sandbox, sandbox } from "../../engine/test/lib/sandbox.ts";

let built: string;
let buildDir: string;
beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "sm-cli-"));
  built = join(buildDir, "smd");
  execFileSync(process.execPath, ["build.mts", built], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "ignore",
  });
  goSm();
}, 300_000);
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// `config read` prints the file as stored, with the marker the JSON
// files carry and the store has no use for.
const withoutFileMarker = (doc: unknown) => {
  const { config, ...rest } = (doc ?? {}) as { config?: unknown };
  if (typeof config !== "object" || config === null) return doc;
  const { schemaVersion: _, ...stored } = config as Record<string, unknown>;
  return { ...rest, config: stored };
};

// A project row's hue, which the engine leaves null (V3.md, decision 12).
const withoutHue = (doc: unknown) =>
  Array.isArray(doc)
    ? doc.map((row: unknown) => Object.assign({}, row, { hue: null }))
    : doc;

// A new project's id, random on each side.
const withoutIds = (seen: object) =>
  JSON.parse(
    JSON.stringify(seen).replaceAll(
      /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g,
      "<id>",
    ),
  ) as unknown;

// The same command through both binaries from `cwd`, each on its own
// copy. Under --json the documents are compared, not their bytes (Go
// sorts keys and escapes <, > and &); a person's output is compared as
// text.
const sameAt = async (cwd: string, ...args: string[]) => {
  const [go, ours] = await Promise.all([
    box.runAt(goSm(), "go", cwd, args),
    box.runAt(built, "cli", cwd, args),
  ]);
  const seen = (run: typeof go) =>
    withoutIds(
      args.includes("--json")
        ? {
            code: run.code,
            doc: withoutHue(withoutFileMarker(run.doc)),
            stderr: run.stderr,
          }
        : { code: run.code, stdout: run.stdout, stderr: run.stderr },
    );
  assert.deepStrictEqual(seen(ours), seen(go), args.join(" "));
};

const same = (...args: string[]) => sameAt(box.home, ...args);

describe("config", () => {
  it("lists, gets and reads a fresh install's settings", async () => {
    await same("--json", "config", "list");
    await same("config", "list");
    await same("config", "get", "doubutsuNames");
    await same("--json", "config", "get", "launchers");
    await same("--json", "config", "read");
    await same("config", "read");
  });

  it("refuses what Go refuses, with its words and exit codes", async () => {
    box.write("registry.json", { projects: [] });
    await same("config", "get", "nope");
    await same("--json", "config", "get", "theme");
    await same("config", "set", "autoPullNew", "maybe");
    await same("--json", "config", "set", "launchers", "x");
    await same("config", "set", "hiddenLaunchers", "x");
    await same(
      "--json",
      "config",
      "write",
      "--data",
      '{"launchScripts":"yes"}',
    );
  });

  // The parser's words are effect/cli's, so only the outcome is Go's.
  it("exits 2 on a command used wrongly, and 0 on help", async () => {
    const misuses = [
      ["--json", "config", "get"],
      ["--json", "config", "bogus"],
      ["--json", "config", "set", "--foo", "x", "y"],
    ];
    const runs = await Promise.all(
      misuses.map((args) => box.runAt(built, "cli", box.home, args)),
    );
    for (const run of runs) {
      assert.equal(run.code, 2, run.stdout);
      assert.equal((run.doc as { ok?: unknown }).ok, false, run.stdout);
    }
    const help = await box.runAt(built, "cli", box.home, ["--help"]);
    assert.equal(help.code, 0);
  });

  it("sets, unsets and writes, then reads back the same", async () => {
    box.write("config.json", { portPool: true, fromNewerBuild: 1 });
    box.write("registry.json", { projects: [] });
    await same("config", "set", "terrier", "on");
    await same("--json", "config", "set", "deleteBranchOnRemove", "no");
    await same("config", "unset", "portPool");
    await same(
      "--json",
      "config",
      "write",
      "--data",
      '{"launchScripts":false,"launchers":[{"id":"a","label":"A","command":"a"}]}',
    );
    await same("--json", "config", "list");
  });
});

describe("projects", () => {
  // Two projects and one whose folder is gone, in a manual order.
  const projects = () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const alpha = box.repo("alpha", { "public/favicon.svg": svg });
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
        { id: "G", name: "gone", path: `${box.home}/gone` },
      ],
      projectOrder: [beta, alpha],
    });
    return { alpha, beta };
  };

  it("says when there are none", async () => {
    await same("projects", "list");
    await same("--json", "projects", "list");
  });

  it("lists the projects in their order", async () => {
    projects();
    await same("projects", "list");
    await same("projects", "ls");
    await same("p", "list", "--refresh-icons", "--json");
  });

  it("lists terrier's projects beside the registry's", async () => {
    projects();
    box.fakeBin(
      "terrier",
      `if [ "$1" = version ]; then echo v0.1.4; else echo '${JSON.stringify({
        projects: [{ path: box.repo("zeta") }],
      })}'; fi`,
    );
    box.write("config.json", { terrier: true });
    await same("projects", "list");
    await same("--json", "projects", "list");
  });

  it("warns when terrier can't be read", async () => {
    projects();
    box.fakeBin("terrier", "echo v0.2.0");
    box.write("config.json", { terrier: true });
    await same("projects", "list");
    await same("--json", "projects", "list");
  });

  it("prints a project's icon, named or at the cwd", async () => {
    const { alpha, beta } = projects();
    await same("--json", "projects", "icon", "alpha");
    await same("projects", "icon", "-p", "alpha");
    await same("--json", "projects", "icon", "--project-id", "B");
    await same("projects", "icon", "beta");
    await same("projects", "icon", "alpha", "-p", "");
    await sameAt(alpha, "--json", "projects", "icon");
    await sameAt(beta, "projects", "icon");
  });

  it("refuses a project it can't name, as Go does", async () => {
    projects();
    await same("projects", "icon", "nope");
    await same("--json", "projects", "icon", "--project-id", "nope");
    await same("--json", "projects", "icon");
    await same("projects", "config", "list", "-p", `${box.home}/elsewhere`);
  });

  it("lists, gets, sets and unsets a project's settings", async () => {
    const { alpha } = projects();
    await same("--json", "projects", "config", "list", "-p", "alpha");
    await same("projects", "config", "-p", "alpha", "list");
    await sameAt(alpha, "--json", "projects", "config", "read");
    await same("projects", "config", "set", "portBase", "4000", "-p", "beta");
    await sameAt(alpha, "projects", "config", "set", "scripts.setup", "pnpm i");
    await same(
      "--json",
      "projects",
      "config",
      "get",
      "scripts.setup",
      "-p",
      "alpha",
    );
    await same("projects", "config", "unset", "scripts.setup", "-p", "alpha");
    await same(
      "projects",
      "config",
      "set",
      "scripts.teardown",
      "",
      "-p",
      "alpha",
    );
    await same(
      "--json",
      "projects",
      "config",
      "set",
      "worktreeLayout",
      "sideways",
      "-p",
      "alpha",
    );
    await same("projects", "config", "set", "carryOver", "x", "-p", "alpha");
    await same("--json", "projects", "config", "read", "-p", "beta");
  });
});

describe("projects add, remove and reorder", () => {
  it("adds the repo a folder is in, at its primary checkout", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta", {
      "package.json": "{}",
      "pnpm-lock.yaml": "",
      "src/index.ts": "",
    });
    box.write("registry.json", { projects: [] });
    box.write("config.json", {
      autoPullNew: true,
      autoPopulateInstall: true,
    });
    await sameAt(alpha, "projects", "add");
    await same("--json", "projects", "add", `${beta}/src`);
    await same("--json", "projects", "config", "read", "-p", "beta");
    await same("--json", "projects", "config", "read", "-p", "alpha");
    await same("projects", "add", "beta");
    await same("--json", "projects", "add", "alpha");
    await same("projects", "add", box.home);
    await same("--json", "projects", "list");
  });

  it("adds every repo under a folder once told yes", async () => {
    box.repo("one");
    box.repo("two");
    box.repo(".hidden");
    box.repo("node_modules");
    const known = box.repo("known");
    box.write("registry.json", {
      projects: [{ id: "K", name: "known", path: known }],
    });
    await same("projects", "add", "--all", box.home);
    await same("--json", "projects", "add", "-a", "-y", box.home);
    await same("projects", "add", "--all", "--yes", box.home);
    await same("--json", "projects", "add", "--all", `${box.home}/nowhere`);
  });

  it("removes a project once told yes, and leaves terrier's", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.git(alpha, "worktree", "add", "-q", "-b", "w", `${box.home}/w`);
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    box.fakeBin(
      "terrier",
      `if [ "$1" = version ]; then echo v0.1.4; else echo '${JSON.stringify({
        projects: [{ path: box.repo("zeta") }],
      })}'; fi`,
    );
    box.write("config.json", { terrier: true });
    await same("projects", "remove", "alpha");
    await same("--json", "projects", "remove");
    await same("projects", "remove", "zeta", "--yes");
    await same("--json", "projects", "rm", "--project-id", "B", "-y");
    await same("projects", "remove", "alpha", "-y");
    await same("--json", "projects", "remove", "--project-id", "B", "-y");
    await same("--json", "projects", "list");
  });

  it("reorders the projects by id", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    await same("projects", "reorder");
    await same("--json", "projects", "reorder", "--ids", "B, nope,A");
    await same("projects", "list");
    await same("projects", "reorder", "--ids", "A");
    await same("--json", "projects", "list");
  });
});

describe("doctor", () => {
  // Each side's data dir, which the checklist names, as one.
  const sideNeutral = (seen: unknown): unknown =>
    JSON.parse(
      ["go", "cli"].reduce(
        (text, side) =>
          text
            .replaceAll(`${box.home}/${side}`, "<data>")
            .replaceAll(`~/${side}`, "<data>"),
        JSON.stringify(seen),
      ),
    ) as unknown;
  const sameDoctor = async (...args: string[]) => {
    const [go, ours] = await Promise.all([
      box.runAt(goSm(), "go", box.home, args),
      box.runAt(built, "cli", box.home, args),
    ]);
    const seen = (run: typeof go) =>
      sideNeutral(
        args.includes("--json")
          ? { code: run.code, doc: run.doc, stderr: run.stderr }
          : { code: run.code, stdout: run.stdout, stderr: run.stderr },
      );
    assert.deepStrictEqual(seen(ours), seen(go), args.join(" "));
  };

  // A gh that is signed in, so its line reads the same on any machine.
  beforeEach(() => {
    box.fakeBin(
      "gh",
      'case "$1" in auth) exit 0;; --version) echo "gh version 9.9.9 (2026-01-01)";; esac',
    );
  });

  // A project that is there and one whose repo is gone.
  beforeEach(() => {
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [
        { id: "P1", name: "repo", path: repo },
        { id: "P2", name: "ghost", path: `${box.home}/ghost` },
      ],
    });
    box.write("projects/P1/project.json", { defaultBranch: "main" });
    box.write("projects/P2/project.json", { defaultBranch: "main" });
  });

  it("checks the install, and refuses a command line it can't use", async () => {
    await sameDoctor("doctor");
    await sameDoctor("--json", "doctor");
    await sameDoctor("doctor", "--yes");
    await sameDoctor("--json", "doctor", "extra");
  });

  it("repairs what it can, asking before a deletion", async () => {
    await sameDoctor("doctor", "--fix");
    await sameDoctor("--json", "doctor", "--fix", "--yes");
    await sameDoctor("doctor");
  });
});

describe("launchers", () => {
  it("lists a project's row and the catalog", async () => {
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [{ id: "R", name: "repo", path: repo }],
    });
    box.write("config.json", {
      launchers: [{ id: "c1", label: "Shell", command: "zsh" }],
      hiddenLaunchers: ["app:finder"],
    });
    await same("--json", "launchers", "-p", "repo");
    await same("launchers", "list", "-p", "repo");
    await sameAt(repo, "launchers");
    await same("--json", "launchers", "--catalog");
    await same("launchers", "--catalog");
    await same("launchers", "bogus", "-p", "repo");
  });
});

// --- shell integration, cd and run ---------------------------------------

// What a binary did, run with more of the environment than the sandbox
// gives it: how it ended, killed by a signal included, and what it
// printed.
type Ended = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

const sides = () => [
  { name: "go", binary: goSm() },
  { name: "cli", binary: built },
];

const start = (
  binary: string,
  side: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
) => {
  const child = spawn(binary, args, {
    cwd,
    env: { ...box.env(side), ...env },
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

// Each side's own home, seeded with the same files, since what install
// writes goes in the shell's config there. `null` names a folder.
const homeOf = (side: string) => join(box.home, `home-${side}`);
const seedHomes = (files: Record<string, string | null> = {}) => {
  for (const { name } of sides()) {
    mkdirSync(homeOf(name), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      const target = join(homeOf(name), file);
      mkdirSync(content === null ? target : dirname(target), {
        recursive: true,
      });
      if (content !== null) writeFileSync(target, content, { mode: 0o600 });
    }
  }
};

// Every file under a home, with its permissions.
const filesUnder = (home: string) =>
  Object.fromEntries(
    readdirSync(home, { recursive: true })
      .map(String)
      .filter((file) => statSync(join(home, file)).isFile())
      .toSorted()
      .map((file) => [
        file,
        {
          mode: statSync(join(home, file)).mode & 0o777,
          text: readFileSync(join(home, file), "utf8"),
        },
      ]),
  );

// A shell verb on both sides, each in its own home: how it ended, what it
// printed with each home named alike, and what it left in the home.
const sameInHomes = async (
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<void> => {
  const runs = await Promise.all(
    sides().map(async ({ name, binary }) => {
      const home = homeOf(name);
      const { code, signal, stdout, stderr } = await start(
        binary,
        name,
        box.home,
        args,
        { HOME: home, ...env },
      ).ended;
      const named = (text: string) => text.replaceAll(home, "<home>");
      return {
        code,
        signal,
        stdout: args.includes("--json")
          ? (JSON.parse(named(stdout)) as unknown)
          : stdout,
        stderr: named(stderr),
        files: filesUnder(home),
      };
    }),
  );
  assert.deepStrictEqual(runs[1], runs[0], args.join(" "));
};

describe("shell", () => {
  it("prints the wrapper for each shell", async () => {
    await same("shell", "init", "zsh");
    await same("shell", "init", "bash");
    await same("--json", "shell", "init", "fish");
    await same("shell", "init", "tcsh");
  });

  it("installs, refreshes and uninstalls the hook in each shell's config", async () => {
    seedHomes({ ".zshrc": "export A=1\n", ".profile": "# mine\n" });
    const zsh = { SHELL: "/bin/zsh" };
    await sameInHomes({}, "shell", "status");
    await sameInHomes({}, "--json", "shell", "status");
    await sameInHomes({}, "shell", "install");
    await sameInHomes(zsh, "shell", "install");
    // Idempotent.
    await sameInHomes(zsh, "--json", "shell", "install", "zsh");
    await sameInHomes({}, "shell", "install", "bash");
    await sameInHomes({}, "shell", "install", "fish");
    await sameInHomes({}, "shell", "install", "tcsh");
    await sameInHomes(zsh, "shell", "status");
    await sameInHomes({ SHIGOMORI_CD_FILE: "/x" }, "shell", "status");
    await sameInHomes(zsh, "--json", "shell", "status");
    await sameInHomes({}, "shell", "uninstall");
    await sameInHomes({}, "shell", "uninstall");
    await sameInHomes({}, "--json", "shell", "uninstall");
    await sameInHomes({}, "shell", "status");
  });

  it("refreshes an older hook in place, and leaves an edited one alone", async () => {
    const begin = "# >>> shigomori-dev shell integration >>>";
    const end = "# <<< shigomori-dev shell integration <<<";
    seedHomes({
      // An older guard line, mid-file.
      ".zshrc": `a\n\n${begin}\neval "$(smd shell init zsh)"\n${end}\nb\n`,
      ".bash_profile": `${begin}\necho mine\n${end}\n`,
      ".config/fish/conf.d/shigomori-dev.fish": "set -x A 1\n",
    });
    await sameInHomes({}, "--json", "shell", "status");
    await sameInHomes({}, "shell", "install", "zsh");
    await sameInHomes({}, "shell", "install", "bash");
    await sameInHomes({}, "--json", "shell", "install", "fish");
    await sameInHomes({}, "shell", "status");
    await sameInHomes({}, "shell", "uninstall");
    await sameInHomes({}, "--json", "shell", "uninstall");
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
  const scripts = ["ok", "fail", "term", "kill", "args", "wait", "sleep"];
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

// The same command on both sides from `cwd`, compared by how each ended
// and what it printed, documents as documents up to a `--`.
const sameEnding = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
) => {
  const end = args.indexOf("--");
  const json = (end === -1 ? args : args.slice(0, end)).includes("--json");
  const [go, ours] = await Promise.all(
    sides().map(
      ({ name, binary }) => start(binary, name, cwd, args, env).ended,
    ),
  );
  const seen = (run: Ended | undefined) =>
    json
      ? {
          ...run,
          stdout: run?.stdout
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as unknown),
        }
      : run;
  assert.deepStrictEqual(seen(ours), seen(go), args.join(" "));
  return go as Ended;
};

describe("cd", () => {
  it("writes the worktree's path to the wrapper's directive file", async () => {
    const { repo, worktree } = scripted();
    const runs = await Promise.all(
      sides().map(async ({ name, binary }) => {
        const cdFile = join(box.home, `cd-${name}`);
        writeFileSync(cdFile, "");
        const ended = await start(binary, name, repo, ["cd", "w"], {
          SHIGOMORI_CD_FILE: cdFile,
        }).ended;
        return Object.assign({}, ended, {
          directive: readFileSync(cdFile, "utf8"),
        });
      }),
    );
    assert.deepStrictEqual(runs[1], runs[0]);
    assert.equal(runs[0]?.directive, `${worktree}\n`);
    const cdFile = { SHIGOMORI_CD_FILE: join(box.home, "unused") };
    await sameEnding(worktree, cdFile, "cd", "w");
    await sameEnding(repo, cdFile, "cd", "nope");
    await sameAt(repo, "--json", "cd", "w");
    await sameEnding(repo, {}, "cd", "w");
    await sameEnding(repo, cdFile, "cd");
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
  it("lists the worktree's scripts", async () => {
    const { repo, worktree } = scripted();
    await sameAt(worktree, "run");
    await sameAt(worktree, "--json", "run");
    await sameAt(
      box.home,
      "--json",
      "run",
      "--project-id",
      "R",
      "--worktree-id",
      "nope",
    );
    await sameAt(box.home, "run");
    await sameAt(box.repo("loose"), "run");
    await sameAt(`${repo}/sub`, "--json", "run", "ok");
    await sameAt(worktree, "run", "nope");
  });

  it("refuses a worktree with no package.json, by its code", async () => {
    const bare = box.repo("bare");
    box.write("registry.json", {
      projects: [{ id: "B", name: "bare", path: bare }],
    });
    await sameAt(bare, "--json", "run");
    await sameAt(bare, "run", "x");
  });

  it("says when the lockfile's manager isn't on PATH", async () => {
    const repo = box.repo("repo", {
      "package.json": JSON.stringify({ scripts: { ok: "ok" } }),
      "pnpm-lock.yaml": "",
    });
    box.write("registry.json", {
      projects: [{ id: "R", name: "repo", path: repo }],
    });
    await sameEnding(repo, { PATH: "/usr/bin:/bin" }, "run", "ok");
  });

  it("ends as the script did", async () => {
    const { worktree } = scripted();
    const [ok, fail, term, kill] = await Promise.all(
      ["ok", "fail", "term", "kill"].map((script) =>
        sameEnding(worktree, {}, "run", script),
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
  });

  it("passes what follows -- to the script as it is, from the worktree's root", async () => {
    const { repo, worktree } = scripted();
    const env = { SHIGOMORI_CD_FILE: "/x", SHIGOMORI_SCRIPT_NAME: "stale" };
    const ran = await sameEnding(
      `${repo}/sub`,
      env,
      "run",
      "args",
      "--",
      "--json",
      "-h",
      "--help",
      "a b",
      "--",
      "--project-id",
    );
    assert.match(
      ran.stdout,
      /^\[--\]\n\[--json\]\n\[-h\]\n\[--help\]\n\[a b\]\n\[--\]\n\[--project-id\]\n/,
    );
    assert.match(ran.stdout, /SHIGOMORI_SCRIPT_NAME=args/);
    assert.doesNotMatch(ran.stdout, /SHIGOMORI_CD_FILE/);
    await sameEnding(worktree, {}, "run", "args", "plain", "--json");
    await sameEnding(worktree, {}, "run", "--worktree-id", "nope", "args");
  });

  // A signal sent to sm reaches the script, and sm ends as Go's sm,
  // which is the script by then, does.
  it.each([
    ["SIGINT", "wait"],
    ["SIGTERM", "wait"],
    ["SIGTERM", "sleep"],
    ["SIGINT", "sleep"],
  ] as const)("passes %s on to the %s script", async (signal, script) => {
    const { worktree } = scripted();
    const runs = await Promise.all(
      sides().map(async ({ name, binary }) => {
        const mark = join(box.home, `mark-${name}`);
        const ready = join(box.home, `ready-${name}`);
        const run = start(binary, name, worktree, ["run", script], {
          MARK: mark,
          READY: ready,
        });
        await appeared(ready);
        run.child.kill(signal);
        const ended = await run.ended;
        return Object.assign({}, ended, {
          mark: existsSync(mark) ? readFileSync(mark, "utf8") : "",
        });
      }),
    );
    assert.deepStrictEqual(runs[1], runs[0]);
    if (script === "wait") {
      assert.equal(runs[0]?.mark, `${signal.slice(3)}\n`);
    } else {
      assert.equal(runs[0]?.signal, signal);
    }
  });
});
