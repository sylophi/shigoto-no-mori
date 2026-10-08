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
import * as Paths from "../../src/Paths.ts";
import * as Store from "../../src/Store.ts";

// The services a harness case calls.
export type Engine = Config.Config;

const cliDir = join(import.meta.dirname, "..", "..", "..", "..", "cli");

// git's variables point a child at the repository a hook runs in, and
// the user's git config would reach the sandbox's repos.
const scrubbedEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  LC_ALL: "C",
});

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
    env: scrubbedEnv(),
    stdio: ["ignore", "ignore", "inherit"],
  });
  renameSync(partial, binary);
  return binary;
}

export type Sandbox = {
  readonly home: string;
  // Writes a JSON file under the data dir.
  readonly write: (file: string, value: unknown) => void;
  // A copy of the data dir for each side, taken when first asked for.
  readonly go: (...args: string[]) => Promise<unknown>;
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
      Config.layer.pipe(
        Layer.provideMerge(Store.layer),
        Layer.provideMerge(Paths.layer("dev")),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: root,
                SHIGOMORI_DATA_DIR: dataDir,
              },
            }),
          ),
        ),
      ),
    );
    return runtime;
  };

  // The verb's last document, as `sm --json` prints it.
  const go = (...args: string[]) =>
    new Promise<unknown>((resolve, reject) => {
      execFile(
        goSm(),
        ["--json", ...args],
        {
          cwd: root,
          env: { ...scrubbedEnv(), HOME: root, SHIGOMORI_DATA_DIR: side("go") },
        },
        (error, stdout) => {
          const docs = stdout
            .split("\n")
            .filter((line) => line.startsWith("{"))
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
    go,
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
