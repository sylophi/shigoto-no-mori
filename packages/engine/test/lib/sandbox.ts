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
import * as CarryOver from "../../src/CarryOver.ts";
import * as CloneCheckout from "../../src/CloneCheckout.ts";
import * as Config from "../../src/Config.ts";
import * as Darwin from "../../src/Darwin.ts";
import * as Git from "../../src/Git.ts";
import * as GitHub from "../../src/GitHub.ts";
import * as Icons from "../../src/Icons.ts";
import * as Identity from "../../src/Identity.ts";
import * as Launchers from "../../src/Launchers.ts";
import * as Lifecycle from "../../src/Lifecycle.ts";
import * as Layout from "../../src/Layout.ts";
import * as Paths from "../../src/Paths.ts";
import * as Registry from "../../src/Registry.ts";
import * as Scripts from "../../src/Scripts.ts";
import * as Terrier from "../../src/Terrier.ts";
import * as Usage from "../../src/Usage.ts";
import { nodeStore } from "./nodeStore.ts";
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
  | Terrier.Terrier
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
  built ??= buildGo(
    cliDir,
    "sm",
    (file) =>
      file.startsWith("embed/") ||
      file === "go.mod" ||
      file === "go.sum" ||
      (file.endsWith(".go") &&
        !file.endsWith("_test.go") &&
        !file.includes("/")),
  );
  return built;
}

// A Go program built from `dir` into a folder named for the hash of its
// sources (the files `include` takes), so a build is reused until they
// change.
function buildGo(
  dir: string,
  name: string,
  include: (file: string) => boolean,
): string {
  const hash = createHash("sha256");
  for (const rel of readdirSync(dir, { recursive: true })
    .map(String)
    .filter(include)
    .toSorted()) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(dir, rel)));
  }
  const binary = join(
    tmpdir(),
    `${name}-parity-${hash.digest("hex").slice(0, 16)}`,
    name,
  );
  if (existsSync(binary)) return binary;
  mkdirSync(dirname(binary), { recursive: true });
  const partial = `${binary}.${process.pid}`;
  execFileSync("go", ["build", "-buildvcs=false", "-o", partial, "."], {
    cwd: dir,
    env: childEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}

// What a binary did: its exit code, its last JSON document, its output.
type Run = {
  readonly code: number;
  readonly doc: unknown;
  readonly docs: ReadonlyArray<unknown>;
  readonly stdout: string;
  readonly stderr: string;
};

// The stable code Go's error document carries beside the message, for
// the failures the app maps without reading prose. Go codes an unknown
// project only where the app names it by id, so that one is the
// terminal's to add.
const CODES = [
  [Worktrees.UnknownWorktree, "unknown-worktree"],
  [Worktrees.PullRequestOwnsDescription, "pull-request-open"],
] as const;
const codeOf = (error: unknown) => {
  const code =
    error instanceof Worktrees.DirtyWorktree
      ? error.reason === "uncommitted"
        ? "uncommitted-changes"
        : "status-unreadable"
      : CODES.find(([cls]) => error instanceof cls)?.[1];
  return code === undefined ? {} : { code };
};

// What the terminal says for a failure: git's own words for a git that
// failed, the message otherwise.
const messageOf = (error: unknown): string =>
  error instanceof Git.GitCommandError
    ? Git.stderrOf(error)
    : error instanceof CloneCheckout.HookFailed
      ? `post-checkout hook: ${messageOf(error.cause)}`
      : error instanceof CloneCheckout.CheckoutUnfinished
        ? messageOf(error.cause)
        : error instanceof Error
          ? error.message
          : String(error);

// Copies `names` from one folder to another as they are, links and
// times included: worktrees name their repo by absolute path.
const copyAll = (from: string, to: string, names: ReadonlyArray<string>) => {
  for (const name of names) {
    cpSync(join(from, name), join(to, name), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }
};

// The darwin helper as macfs/ is now, built once per state of its
// sources, for the Darwin service.
let macfsBuilt: string | undefined;

export function macfs(): string {
  macfsBuilt ??= buildGo(
    join(cliDir, "..", "macfs"),
    "macfs",
    (file) =>
      file === "go.mod" ||
      file === "go.sum" ||
      (file.endsWith(".go") &&
        !file.endsWith("_test.go") &&
        !file.includes("/")),
  );
  return macfsBuilt;
}

export type Sandbox = {
  readonly home: string;
  // Writes a JSON file under the data dir.
  readonly write: (file: string, value: unknown) => void;
  // A copy of the data dir for each side, taken when first asked for.
  readonly go: (...args: string[]) => Promise<unknown>;
  // Any binary, against its own copy of the data dir named `side`.
  readonly runAt: (
    binary: string,
    side: string,
    cwd: string,
    args: ReadonlyArray<string>,
  ) => Promise<Run>;
  // The same, run from `cwd`.
  readonly goAt: (cwd: string, ...args: string[]) => Promise<unknown>;
  // Every document the verb prints, in order.
  readonly goDocs: (
    cwd: string,
    ...args: string[]
  ) => Promise<ReadonlyArray<unknown>>;
  // A verb that changes what both sides share (the repos, the
  // worktrees): Go's side first, then the engine's against everything
  // restored to how it was. Answers both.
  readonly changeBoth: <A, B>(
    go: () => Promise<A>,
    engine: () => Promise<B>,
  ) => Promise<[A, B]>;
  // A git repository at `name` beside the data dirs, which both sides
  // share, with `files` committed.
  readonly repo: (name: string, files?: Record<string, string>) => string;
  // git in `cwd` with the sandbox's identity, answering its stdout.
  readonly git: (cwd: string, ...args: string[]) => string;
  readonly engine: <A, E>(run: Effect.Effect<A, E, Engine>) => Promise<unknown>;
  // A command on PATH for this sandbox's life, as a shell script.
  readonly fakeBin: (name: string, script: string) => void;
  readonly remove: () => Promise<void>;
};

export function sandbox(): Sandbox {
  const originalPath = process.env.PATH;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engine-parity-")));
  const seed = join(root, "seed");
  mkdirSync(seed);
  const sides = new Set<string>();
  const sideDir = (name: string) => {
    sides.add(name);
    const dir = join(root, name);
    if (!existsSync(dir)) cpSync(seed, dir, { recursive: true });
    return dir;
  };

  let runtime: ManagedRuntime.ManagedRuntime<Engine, unknown> | undefined;
  const engineRuntime = () => {
    const dataDir = sideDir("engine");
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
            Lifecycle.layer,
            CarryOver.layer,
            CloneCheckout.layer,
          ),
        ),
        Layer.provideMerge(Terrier.layer),
        Layer.provideMerge(Darwin.layer(macfs())),
        Layer.provideMerge(
          Layer.mergeAll(
            Config.layer,
            Usage.layer,
            Identity.layer,
            Icons.layer,
          ),
        ),
        Layer.provideMerge(Git.layer),
        Layer.provideMerge(nodeStore),
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

  // Read when a command runs, so a test's PATH change reaches it.
  const gitEnv = () => ({
    ...childEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });

  // A binary run from `cwd` against its own copy of the data dir
  // (`side`): its exit code, its last JSON document and its stderr.
  const runAt = (
    binary: string,
    side: string,
    cwd: string,
    args: ReadonlyArray<string>,
  ) =>
    new Promise<Run>((resolve, reject) => {
      execFile(
        binary,
        [...args],
        {
          cwd,
          env: { ...gitEnv(), HOME: root, SHIGOMORI_DATA_DIR: sideDir(side) },
        },
        (error, stdout, stderr) => {
          // A spawn failure or a signal has no exit code to compare.
          if (error !== null && typeof error.code !== "number") {
            reject(error);
            return;
          }
          const docs = stdout
            .split("\n")
            .filter((line) => line.startsWith("{") || line.startsWith("["))
            .map((line) => JSON.parse(line) as unknown);
          resolve({
            code: typeof error?.code === "number" ? error.code : 0,
            doc: docs.at(-1),
            docs,
            stdout,
            stderr,
          });
        },
      );
    });

  // The verb's last document, as `sm --json` prints it.
  const goAt = (cwd: string, ...args: string[]) =>
    runAt(goSm(), "go", cwd, ["--json", ...args]).then(({ doc, stderr }) => {
      if (doc === undefined) throw new Error(`no document: ${stderr}`);
      return doc;
    });

  // Every document the verb prints, in order.
  const goDocs = (cwd: string, ...args: string[]) =>
    runAt(goSm(), "go", cwd, ["--json", ...args]).then(({ docs, stderr }) => {
      if (docs.length === 0) throw new Error(`no document: ${stderr}`);
      return docs;
    });

  // What the sides share in the home directory: everything but their
  // data dirs, the seed and the fake commands.
  const shared = () =>
    readdirSync(root).filter(
      (name) => !sides.has(name) && !["seed", "bin", ".before"].includes(name),
    );
  const before = join(root, ".before");

  return {
    home: root,
    write: (file, value) => {
      mkdirSync(dirname(join(seed, file)), { recursive: true });
      writeFileSync(join(seed, file), JSON.stringify(value));
    },
    go: (...args) => goAt(root, ...args),
    goDocs,
    changeBoth: async (goSide, engineSide) => {
      rmSync(before, { recursive: true, force: true });
      mkdirSync(before);
      copyAll(root, before, shared());
      const go = await goSide();
      for (const name of shared()) {
        rmSync(join(root, name), { recursive: true, force: true });
      }
      copyAll(before, root, readdirSync(before));
      return [go, await engineSide()];
    },
    runAt,
    git: (cwd, ...args) =>
      execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }),
    goAt,
    repo: (name, files = {}) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, env: gitEnv(), stdio: "ignore" });
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
              error: messageOf(error),
              ...codeOf(error),
            }),
          }),
        ),
      ),
    fakeBin: (name, script) => {
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, {
        mode: 0o755,
      });
      if (!process.env.PATH?.startsWith(`${bin}:`)) {
        process.env.PATH = `${bin}:${originalPath}`;
      }
    },
    remove: async () => {
      process.env.PATH = originalPath;
      await runtime?.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
