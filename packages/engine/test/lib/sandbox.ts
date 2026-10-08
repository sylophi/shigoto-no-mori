// What the parity harness runs the Go `sm` and the engine against: a
// home directory holding a 2.x data dir, copied so each side gets its
// own, and the two ways of asking it something.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Config from "../../src/Config.ts";
import * as Git from "../../src/Git.ts";
import * as GitHub from "../../src/GitHub.ts";
import * as Icons from "../../src/Icons.ts";
import * as Identity from "../../src/Identity.ts";
import * as Launchers from "../../src/Launchers.ts";
import * as Layout from "../../src/Layout.ts";
import * as Paths from "../../src/Paths.ts";
import * as Registry from "../../src/Registry.ts";
import * as Scripts from "../../src/Scripts.ts";
import * as Store from "../../src/Store.ts";
import * as Usage from "../../src/Usage.ts";
import * as WorktreeData from "../../src/WorktreeData.ts";
import * as Worktrees from "../../src/Worktrees.ts";

// The services a harness case calls.
export type Engine =
  | Config.Config
  | Icons.Icons
  | Launchers.Launchers
  | Layout.Layout
  | Registry.Registry
  | Scripts.Scripts
  | Usage.Usage
  | Worktrees.Worktrees;

const cliDir = join(import.meta.dirname, "..", "..", "..", "..", "cli");

// git's variables point a child at the repository a hook runs in, and
// the user's git config would reach the sandbox's repos. The engine's
// Git service runs git under this process's environment, so the
// process's own goes the same way.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });

// The Go sm as cli/ is now, built once per state of its sources (the
// non-test Go files, the module files, the embedded data) and hashed
// once per test process.
let built: string | undefined;

export function goSm(): string {
  built ??= buildGoSm();
  return built;
}

function buildGoSm(): string {
  const hash = createHash("sha256");
  for (const rel of readdirSync(cliDir, { recursive: true })
    .map(String)
    .filter(
      (file) =>
        file.startsWith("embed/") ||
        file === "go.mod" ||
        file === "go.sum" ||
        (file.endsWith(".go") &&
          !file.endsWith("_test.go") &&
          !file.includes("/")),
    )
    .toSorted()) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(cliDir, rel)));
  }
  const binary = join(
    tmpdir(),
    `sm-parity-${hash.digest("hex").slice(0, 16)}`,
    "sm",
  );
  if (existsSync(binary)) return binary;
  mkdirSync(dirname(binary), { recursive: true });
  const partial = `${binary}.${process.pid}`;
  execFileSync("go", ["build", "-buildvcs=false", "-o", partial, "."], {
    cwd: cliDir,
    env: childEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}

// The stable code Go's error document carries beside the message, for
// the failures the app maps without reading prose. Go codes an unknown
// project only where the app names it by id, so that one is the
// terminal's to add.
const CODES = [
  [Worktrees.UnknownWorktree, "unknown-worktree"],
  [Worktrees.PullRequestOwnsDescription, "pull-request-open"],
] as const;
const codeOf = (error: unknown) => {
  const code = CODES.find(([cls]) => error instanceof cls)?.[1];
  return code === undefined ? {} : { code };
};

export type Sandbox = {
  readonly home: string;
  // Writes a JSON file under the data dir.
  readonly write: (file: string, value: unknown) => void;
  // A copy of the data dir for each side, taken when first asked for.
  readonly go: (...args: string[]) => Promise<unknown>;
  // The same, run from `cwd`.
  readonly goAt: (cwd: string, ...args: string[]) => Promise<unknown>;
  // A git repository at `name` beside the data dirs, which both sides
  // share, with `files` committed.
  readonly repo: (name: string, files?: Record<string, string>) => string;
  // git in `cwd` with the sandbox's identity, answering its stdout.
  readonly git: (cwd: string, ...args: string[]) => string;
  readonly engine: <A, E>(run: Effect.Effect<A, E, Engine>) => Promise<unknown>;
  readonly remove: () => Promise<void>;
};

export function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engine-parity-")));
  const seed = join(root, "seed");
  mkdirSync(seed);
  const side = (name: string) => {
    const dir = join(root, name);
    if (!existsSync(dir)) cpSync(seed, dir, { recursive: true });
    return dir;
  };

  let runtime: ManagedRuntime.ManagedRuntime<Engine, unknown> | undefined;
  const engineRuntime = () => {
    const dataDir = side("engine");
    runtime ??= ManagedRuntime.make(
      Worktrees.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Launchers.layer,
            Layout.layer,
            Registry.layer,
            Scripts.layer,
            WorktreeData.layer,
            GitHub.layer,
          ),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            Config.layer,
            Usage.layer,
            Identity.layer,
            Icons.layer,
          ),
        ),
        Layer.provideMerge(Git.layer),
        Layer.provideMerge(Store.layer),
        Layer.provideMerge(Paths.layer("dev")),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: root,
                PATH: process.env.PATH ?? "",
                SHIGOMORI_DATA_DIR: dataDir,
              },
            }),
          ),
        ),
      ),
    );
    return runtime;
  };

  const gitEnv = {
    ...childEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  // The verb's last document, as `sm --json` prints it.
  const goAt = (cwd: string, ...args: string[]) =>
    new Promise<unknown>((resolve, reject) => {
      execFile(
        goSm(),
        ["--json", ...args],
        {
          cwd,
          env: { ...gitEnv, HOME: root, SHIGOMORI_DATA_DIR: side("go") },
        },
        (error, stdout) => {
          const docs = stdout
            .split("\n")
            .filter((line) => line.startsWith("{") || line.startsWith("["))
            .map((line) => JSON.parse(line) as unknown);
          if (docs.length === 0) reject(error ?? new Error("no document"));
          else resolve(docs.at(-1));
        },
      );
    });

  return {
    home: root,
    write: (file, value) => {
      mkdirSync(dirname(join(seed, file)), { recursive: true });
      writeFileSync(join(seed, file), JSON.stringify(value));
    },
    go: (...args) => goAt(root, ...args),
    git: (cwd, ...args) =>
      execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }),
    goAt,
    repo: (name, files = {}) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, env: gitEnv, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), content);
      }
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", "init");
      return dir;
    },
    // The service call's answer, or its error as the terminal reports
    // one: {ok: false, error: message}.
    engine: (run) =>
      engineRuntime().runPromise(
        run.pipe(
          Effect.match({
            onSuccess: (value) => value as unknown,
            onFailure: (error) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...codeOf(error),
            }),
          }),
        ),
      ),
    remove: async () => {
      await runtime?.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
