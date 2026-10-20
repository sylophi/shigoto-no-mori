// What the engine's and the terminal's tests run against: a home
// directory holding a 2.x data dir, copied so each side (the engine, a
// binary) gets its own, and the ways of asking it something.
import { execFile, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as Agents from "../../src/Agents.ts";
import * as Bundle from "../../src/Bundle.ts";
import * as CarryOver from "../../src/CarryOver.ts";
import * as Config from "../../src/Config.ts";
import * as Control from "../../src/Control.ts";
import * as DataDirLock from "../../src/DataDirLock.ts";
import * as Doctor from "../../src/Doctor.ts";
import { errorDocument } from "../../src/errorDocument.ts";
import * as Git from "../../src/Git.ts";
import * as GitHub from "../../src/GitHub.ts";
import * as Hygiene from "../../src/Hygiene.ts";
import * as Icons from "../../src/Icons.ts";
import * as Landing from "../../src/Landing.ts";
import * as Launchers from "../../src/Launchers.ts";
import * as Layout from "../../src/Layout.ts";
import * as Projects from "../../src/Projects.ts";
import * as Registry from "../../src/Registry.ts";
import * as Scripts from "../../src/Scripts.ts";
import * as Terrier from "../../src/Terrier.ts";
import * as Transfer from "../../src/Transfer.ts";
import * as Usage from "../../src/Usage.ts";
import { doctorLayer, migratingEngineLayer } from "../../src/layer.ts";
import * as Migration from "../../src/Migration.ts";
import * as Open from "../../src/Open.ts";
import * as Paths from "../../src/Paths.ts";
import * as Store from "../../src/Store.ts";
import { openNode } from "./nodeStore.ts";
import * as Worktrees from "../../src/Worktrees.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorktreeData from "../../src/WorktreeData.ts";
import * as WtFolder from "../../src/WtFolder.ts";
import {
  GIT_IDENTITY,
  isolateGit,
  repositoryRoot,
} from "../../../../gitIsolation.ts";
import { macfs } from "./macfs.ts";
import { SYNC_SPAWN } from "../../../../testProcesses.mts";

// The darwin helper, for the tests that take it with the sandbox's
// environment.
export { macfs };

// The services a harness case calls.
export type Engine =
  | Agents.Agents
  | Bundle.Bundle
  | CarryOver.CarryOver
  | Config.Config
  | DataDirLock.DataDirLock
  | Git.Git
  | GitHub.GitHub
  | Icons.Icons
  | Launchers.Launchers
  | Layout.Layout
  | Open.Open
  | Projects.Projects
  | Registry.Registry
  | Scripts.Scripts
  | Terrier.Terrier
  | Usage.Usage
  | Worktrees.Worktrees
  | Landing.Landing
  | Hygiene.Hygiene
  | Doctor.Doctor
  | Control.Control
  | Transfer.Transfer
  | WtFolder.WtFolder
  | WorktreeData.WorktreeData
  | SqlClient.SqlClient
  | Migration.Migration
  | Paths.Paths;

// What the agent hooks run, as the installed binary names itself.
export const HOOK_BINARY =
  "/Applications/Shigoto no Mori.app/Contents/Resources/smd";

// git's variables point a child at the repository a hook runs in, and
// the user's git config would reach the sandbox's repos. The engine's
// Git service runs git under this process's environment, so the
// process's own goes the same way.
isolateGit();
Object.assign(process.env, {
  // No background gc or maintenance: a sandbox's repos are copied while
  // git runs, and a pack rewritten mid-copy loses files.
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
});

const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });

// What a binary did: its exit code, its last JSON document, its output.
type Run = {
  readonly code: number;
  readonly doc: unknown;
  readonly docs: ReadonlyArray<unknown>;
  readonly stdout: string;
  readonly stderr: string;
};

export type Sandbox = {
  readonly home: string;
  // The data dir of side `name`, copied from the seed when first asked for.
  readonly side: (name: string) => string;
  // Writes a JSON file under the data dir.
  readonly write: (file: string, value: unknown) => void;
  // Any binary, against its own copy of the data dir named `side`.
  readonly runAt: (
    binary: string,
    side: string,
    cwd: string,
    args: ReadonlyArray<string>,
  ) => Promise<Run>;
  // The environment a binary runs in against its own copy of the data
  // dir named `side`.
  readonly env: (side: string) => NodeJS.ProcessEnv;
  // A git repository at `name` beside the data dirs, which every side
  // shares, with `files` committed.
  readonly repo: (name: string, files?: Record<string, string>) => string;
  // This repository at `name`, at the commit checked out, on main: a
  // real project's tree to clone and land from. Its own commit, not a
  // pinned one, since CI's checkout is shallow and holds no other.
  readonly realRepo: (name: string) => string;
  // git in `cwd` with the sandbox's identity, answering its stdout.
  readonly git: (cwd: string, ...args: string[]) => string;
  readonly engine: <A, E>(run: Effect.Effect<A, E, Engine>) => Promise<unknown>;
  // A start of the engine as a new process makes one, on a graph of its
  // own, which closes once it is up: each value its migration takes,
  // from before the store opens.
  readonly start: () => Promise<ReadonlyArray<MigrationProgress>>;
  // The app's start on side `name`, which migrates a 2.x data dir there,
  // as no terminal command but `doctor --fix` does.
  readonly migrate: (name: string) => Promise<void>;
  // A run of the doctor as the terminal builds it, which opens the
  // store inside the run.
  readonly doctor: (input: Doctor.RunInput) => Promise<Doctor.DoctorDocument>;
  // A command on PATH for this sandbox's life, as a shell script.
  readonly fakeBin: (name: string, script: string) => void;
  readonly remove: () => Promise<void>;
};

// `env` is more of the environment the engine reads (a harness's
// config dir, the session a shell runs in).
export function sandbox(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    // The darwin helper in macfs/'s place, for a case where it fails.
    readonly macfs?: string;
  } = {},
): Sandbox {
  const helper = options.macfs ?? macfs();
  const originalPath = process.env.PATH;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engine-sandbox-")));
  const seed = join(root, "seed");
  mkdirSync(seed);
  const sides = new Set<string>();
  const sideDir = (name: string) => {
    sides.add(name);
    const dir = join(root, name);
    // Times kept, so a file the seed backdated stays old.
    if (!existsSync(dir)) {
      cpSync(seed, dir, { recursive: true, preserveTimestamps: true });
    }
    return dir;
  };

  // The platform under a side, the engine's by default, its data dir
  // seeded first.
  const platform = (side = "engine") =>
    Layer.merge(
      NodeServices.layer,
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            HOME: root,
            PATH: process.env.PATH ?? "",
            SHIGOMORI_DATA_DIR: sideDir(side),
            ...options.env,
          },
        }),
      ),
    );
  const graph = () =>
    migratingEngineLayer({
      flavor: "dev",
      store: Store.layer(openNode),
      open: openNode,
      macfs: helper,
      sm: HOOK_BINARY,
    });
  let runtime: ManagedRuntime.ManagedRuntime<Engine, unknown> | undefined;
  const engineRuntime = () => {
    runtime ??= ManagedRuntime.make(
      graph().pipe(
        Layer.provideMerge(Migration.layer),
        Layer.provide(platform()),
      ),
    );
    return runtime;
  };

  const start = () =>
    Effect.gen(function* () {
      const seen: MigrationProgress[] = [];
      const migration = yield* Migration.Migration;
      const watching = yield* Deferred.make<void>();
      yield* migration.changes.pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => seen.push(value)).pipe(
            Effect.andThen(Deferred.succeed(watching, undefined)),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(watching);
      yield* Layer.build(graph());
      // The last change, published as the graph came up.
      yield* Effect.yieldNow;
      return seen;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(Migration.layer, platform())),
      Effect.runPromise,
    );

  // What the app's start makes of side `name`'s data dir: a 2.x one
  // imported into the store and its worktrees moved into `wt/`.
  const migrate = (name: string) =>
    Effect.runPromise(
      Effect.scoped(Layer.build(graph())).pipe(
        Effect.provide(Layer.merge(Migration.layer, platform(name))),
        Effect.asVoid,
      ),
    );

  // Read when a command runs, so a test's PATH change reaches it.
  const gitEnv = () => ({ ...childEnv(), ...GIT_IDENTITY });

  // What a binary sees of this process's environment, as the engine sees
  // only what its runtime is given: PATH, the temp dir, and git's
  // variables with the sandbox's identity.
  const sideEnv = (): NodeJS.ProcessEnv =>
    Object.fromEntries(
      Object.entries(gitEnv()).filter(
        ([name]) =>
          ["PATH", "TMPDIR", "LC_ALL"].includes(name) ||
          name.startsWith("GIT_"),
      ),
    );

  const env = (side: string): NodeJS.ProcessEnv => ({
    ...sideEnv(),
    HOME: root,
    SHIGOMORI_DATA_DIR: sideDir(side),
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
        { cwd, env: env(side) },
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

  return {
    home: root,
    side: sideDir,
    start,
    migrate,
    write: (file, value) => {
      mkdirSync(dirname(join(seed, file)), { recursive: true });
      writeFileSync(join(seed, file), JSON.stringify(value));
    },
    runAt,
    env,
    git: (cwd, ...args) =>
      execFileSync("git", args, {
        ...SYNC_SPAWN,
        cwd,
        env: gitEnv(),
        encoding: "utf8",
      }),
    repo: (name, files = {}) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          ...SYNC_SPAWN,
          cwd: dir,
          env: gitEnv(),
          stdio: "ignore",
        });
      git("init", "-q", "-b", "main");
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), content);
      }
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", "init");
      return dir;
    },
    realRepo: (name) => {
      const dir = join(root, name);
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, {
          ...SYNC_SPAWN,
          cwd,
          env: gitEnv(),
          stdio: "ignore",
        });
      git(
        root,
        "clone",
        "-q",
        "--shared",
        "--no-checkout",
        repositoryRoot,
        dir,
      );
      git(dir, "checkout", "-q", "-B", "main", "HEAD");
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
              ...errorDocument(error),
            }),
          }),
        ),
      ),
    doctor: (input) =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
          doctor.run(input),
        ).pipe(
          Effect.provide(
            doctorLayer({ flavor: "dev", open: openNode, macfs: helper }).pipe(
              Layer.provide(platform()),
            ),
          ),
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
