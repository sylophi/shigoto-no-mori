// The terminal binary, built as it ships, on a sandbox data dir: what
// the engine's tests can't see from a service call. A 2.x data dir is
// left as v2 left it until the app or `doctor --fix` migrates it, the
// shell's config gets back what it held before the hook went in, and
// rm --stack and land keep a worktree whose branch holds a commit its
// merged PR never had.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  onTestFinished,
} from "vitest";
import { type Sandbox, sandbox } from "../../engine/test/lib/sandbox.ts";
import { builtBinary } from "./lib/binary.ts";
import { own as owned } from "../../../test/testProcesses.mts";

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

// The binary handed `input` on stdin, as a harness runs a hook, and
// `env` over the sandbox's: how it ended and its stdout.
const piped = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  input: string,
) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = owned(
      spawn(built, args, {
        cwd,
        env: { ...box.env("cli"), ...env },
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });

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

// The shell's config, which nuke takes the hook out of as `shell
// uninstall` does.
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
      piped(box.home, args, { HOME: home, SHELL: "/bin/zsh" }, "");
    await run("shell", "install");
    // Idempotent.
    await run("shell", "install", "zsh");
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    assert.equal(rc.split(BEGIN).length, 2, rc);
    assert.ok(rc.startsWith("export A=1\n\n"), rc);
    await run("shell", "uninstall");
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), "export A=1\n");
  });

  it("leaves an edited hook alone", async () => {
    const home = homeWith({
      ".zshrc": `${BEGIN}\necho mine\n# <<< shigomori-dev shell integration <<<\n`,
    });
    const before = readFileSync(join(home, ".zshrc"), "utf8");
    const run = (...args: string[]) =>
      piped(box.home, args, { HOME: home }, "");
    await run("shell", "install", "zsh");
    await run("shell", "uninstall");
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), before);
  });

  // A dotfiles manager's link stays one, and the file it tracks gets
  // the hook.
  it("writes a symlinked config through its link", async () => {
    const home = homeWith({ "dotfiles/zshrc": "export A=1\n" });
    symlinkSync("dotfiles/zshrc", join(home, ".zshrc"));
    const run = (...args: string[]) =>
      piped(box.home, args, { HOME: home }, "");
    await run("shell", "install", "zsh");
    assert.ok(lstatSync(join(home, ".zshrc")).isSymbolicLink());
    assert.match(
      readFileSync(join(home, "dotfiles/zshrc"), "utf8"),
      /^export A=1\n\n# >>> shigomori-dev shell integration >>>\n/,
    );
    await run("shell", "uninstall");
    assert.ok(lstatSync(join(home, ".zshrc")).isSymbolicLink());
    assert.equal(
      readFileSync(join(home, "dotfiles/zshrc"), "utf8"),
      "export A=1\n",
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

// rm --stack and land against a scripted gh: a branch holding a commit
// its merged PR never had keeps its worktree.
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
      /PR #4 is in the merge queue. Land again once it merges, for the rest of the stack/,
    );
    const calls = readFileSync(log, "utf8");
    assert.ok(!calls.includes("pr edit 5"), calls);
    assert.ok(!calls.includes("pr merge 5"), calls);
    assert.ok(existsSync(fox), "nothing removed");
  });
});
