// Drives the packaged app's environment rebuild (host/lib/util/shellEnv.ts)
// under plain node: the launchd base, the sentinel parse, the merge
// order, and real zsh runs from a throwaway ZDOTDIR for the capture
// itself: its banner and logout output, a startup file that leaves a
// child behind holding stdout, and its SIGKILL timeout. The Electron
// side (when main/index.ts starts and awaits it) is a human-verify
// item: launch the packaged app from a terminal with a marker variable
// exported, run a script, and the marker must not be in its env.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureShellEnv,
  LAUNCHD_PATH,
  launchBaseEnv,
  mergeShellEnv,
  parseShellEnv,
  replaceProcessEnv,
} from "../host/lib/util/shellEnv.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, it } from "vitest";
import { makeTracker, tempDir } from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();

// An agent's launch from inside an sm worktree: launchd's variables,
// the agent's session (a marker, a token, a node flag), the worktree's
// SHIGOMORI_* contract, and the one override meant for the app.
const LAUNCH = {
  HOME: "/Users/u",
  USER: "u",
  LOGNAME: "u",
  SHELL: "/bin/bash",
  TMPDIR: "/tmp/u/",
  SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
  XPC_FLAGS: "0x0",
  XPC_SERVICE_NAME: "0",
  __CFBundleIdentifier: "com.example.app",
  __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  PATH: "/opt/agent/bin:/usr/bin:/bin",
  PWD: "/Users/u/repo",
  SHLVL: "3",
  TERM: "xterm-256color",
  CLAUDECODE: "1",
  CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  NODE_OPTIONS: "--inspect",
  ELECTRON_RUN_AS_NODE: "1",
  SHIGOMORI_WORKTREE_PATH: "/Users/u/.sm/wt/repo/fox",
  SHIGOMORI_CD_FILE: "/tmp/u/sm-cd.123",
  SHIGOMORI_DATA_DIR: "/tmp/sandbox",
};

const BASE = {
  HOME: "/Users/u",
  USER: "u",
  LOGNAME: "u",
  TMPDIR: "/tmp/u/",
  SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
  XPC_FLAGS: "0x0",
  XPC_SERVICE_NAME: "0",
  __CFBundleIdentifier: "com.example.app",
  __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  PATH: LAUNCHD_PATH,
  SHELL: "/bin/zsh",
};

// When one fails: see host/lib/util/shellEnv.ts: the packaged app's
// environment rebuild.
it("the base is launchd's variables, PATH and the shell, nothing else", () => {
  assert.deepEqual(launchBaseEnv(LAUNCH, "/bin/zsh"), BASE);
});

const wrapped = (entries: string[]): string =>
  `__SHIGOMORI_ENV__${entries.join("\0")}__SHIGOMORI_ENV_END__`;

it("the parse reads between the sentinels and keeps multi-line values", () => {
  const stdout =
    "Welcome!\nLast login: today\n" +
    wrapped([
      "A=1",
      "MULTI=two\nlines",
      "EQ=a=b",
      "BASH_FUNC_f%%=() { :; }",
      "=x",
      "",
    ]) +
    "session=1 ended\n";
  assert.deepEqual(parseShellEnv(stdout), {
    A: "1",
    MULTI: "two\nlines",
    EQ: "a=b",
  });
});

it("no END is no capture yet", () => {
  assert.equal(parseShellEnv("Welcome!\n__SHIGOMORI_ENV__A=1\0"), null);
  assert.equal(parseShellEnv("Welcome!\nA=1\0"), null);
});

it("the merge is base, then exports, then the app's own override", () => {
  const captured = {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    SSH_AUTH_SOCK: "/Users/u/.1password/agent.sock",
    LANG: "en_US.UTF-8",
    GOPATH: "/Users/u/go",
    SHIGOMORI_DATA_DIR: "/Users/u/.sm",
    SHIGOMORI_UPDATE_FEED_URL: "https://example.invalid/feed",
    PWD: "/Users/u",
    OLDPWD: "/",
    SHLVL: "1",
    _: "/usr/bin/env",
  };
  // Nothing of the agent's session or its worktree. The shell's PATH
  // and SSH_AUTH_SOCK over launchd's. The launcher's data dir over the
  // shell's, and the shell's other SHIGOMORI_* not at all. None of the
  // capture shell's own session.
  assert.deepEqual(mergeShellEnv(BASE, captured, LAUNCH), {
    ...BASE,
    PATH: captured.PATH,
    SSH_AUTH_SOCK: captured.SSH_AUTH_SOCK,
    LANG: "en_US.UTF-8",
    GOPATH: "/Users/u/go",
    SHIGOMORI_DATA_DIR: "/tmp/sandbox",
  });
});

it("a profile's SHIGOMORI_DATA_DIR is not the app's", () => {
  const { SHIGOMORI_DATA_DIR: _unset, ...finderLaunch } = LAUNCH;
  const env = mergeShellEnv(
    BASE,
    { SHIGOMORI_DATA_DIR: "/Users/u/.sm" },
    finderLaunch,
  );
  assert.deepEqual(env, BASE);
});

it("a failed capture leaves the Finder-launch environment", () => {
  assert.deepEqual(mergeShellEnv(BASE, null, LAUNCH), {
    ...BASE,
    SHIGOMORI_DATA_DIR: "/tmp/sandbox",
  });
});

it("replaceProcessEnv drops what the target lacks", () => {
  process.env["SM_SHELL_ENV_TEST_GONE"] = "1";
  const { SM_SHELL_ENV_TEST_GONE: _gone, ...target } = process.env as Record<
    string,
    string
  >;
  target["SM_SHELL_ENV_TEST_SET"] = "2";
  replaceProcessEnv(target);
  assert.equal(process.env["SM_SHELL_ENV_TEST_GONE"], undefined);
  assert.equal(process.env["SM_SHELL_ENV_TEST_SET"], "2");
  delete process.env["SM_SHELL_ENV_TEST_SET"];
});

// The real thing: zsh, reading a throwaway ZDOTDIR so the developer's
// own startup files stay out of it. /etc/zprofile still runs
// path_helper, which is the point: PATH comes back rebuilt from the
// system's, not from launchd's four entries.
const ZSH = "/bin/zsh";
const capture = (base: Record<string, string>, timeoutMs?: number) =>
  Effect.runPromise(
    captureShellEnv(ZSH, base, timeoutMs).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
if (existsSync(ZSH)) {
  let zdotdir: string;
  const rc = (lines: string[]): void =>
    writeFileSync(join(zdotdir, ".zshrc"), lines.join("\n") + "\n");
  let base: typeof BASE & { ZDOTDIR: string };
  beforeAll(() => {
    zdotdir = tempDir("sm-shell-env-", track);
    base = { ...BASE, HOME: zdotdir, ZDOTDIR: zdotdir };
  });
  afterAll(teardown);

  it("zsh's exports come back; unexported vars and logout output don't", async () => {
    rc([
      "echo 'Welcome to a chatty .zshrc'",
      "export SM_SHELL_ENV_TEST_EXPORT=$'two\\nlines'",
      'export PATH="/opt/test/bin:$PATH"',
      "SM_SHELL_ENV_TEST_UNEXPORTED=1",
    ]);
    writeFileSync(join(zdotdir, ".zlogout"), "echo 'session=1 ended'\n");
    const captured = await capture(base);
    assert.notEqual(captured, null, "the capture failed");
    assert.equal(captured?.["SM_SHELL_ENV_TEST_EXPORT"], "two\nlines");
    assert.equal(captured?.["SM_SHELL_ENV_TEST_UNEXPORTED"], undefined);
    assert.equal(captured?.["session"], undefined);
    assert.match(captured?.["PATH"] ?? "", /^\/opt\/test\/bin:/);
  });

  let started: number;
  it("a child holding stdout does not hold the capture", async () => {
    // A startup file that leaves a child behind with the shell's stdout
    // (an agent, a `nohup x &`). The shell is done at once and so must
    // the capture be, not when the child lets go of the pipe.
    rc(["(sleep 2 &)", "export SM_SHELL_ENV_TEST_EXPORT=orphaned"]);
    started = Date.now();
    const orphaned = await capture(base);
    assert.equal(orphaned?.["SM_SHELL_ENV_TEST_EXPORT"], "orphaned");
    assert.ok(
      Date.now() - started < 1500,
      "the capture waited for the orphan's stdout instead of the shell's END",
    );
  });

  it("a shell that exits early is a failed capture, whoever holds stdout", async () => {
    // The startup file leaves a child holding stdout, then ends the
    // shell before env runs: no END will come, and no EOF either.
    rc(["(sleep 2 &)", "exit 3"]);
    started = Date.now();
    const early = await capture(base);
    assert.equal(early, null);
    assert.ok(
      Date.now() - started < 1500,
      "the capture waited for the orphan's stdout instead of the shell's exit",
    );
  });

  it("a hanging startup file is a failed capture, on time", async () => {
    // A startup file that hangs. Interactive zsh ignores SIGTERM, so
    // this is also the proof the timeout really ends the shell.
    rc(["sleep 1"]);
    started = Date.now();
    const hung = await capture(base, 200);
    assert.equal(hung, null);
    assert.ok(
      Date.now() - started < 1500,
      "the timeout waited out the sleep instead of killing the shell",
    );
  });
} else {
  console.log("(no /bin/zsh here, the live capture checks were skipped)");
}
