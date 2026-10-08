// The parity harness: each verb the engine can answer, run as the Go
// `sm --json` and as the engine's service call against copies of one
// sandbox, and the two documents compared. The CLI's surface is frozen
// (V3.md, decision 13), so a difference here is a bug in the engine,
// whatever the engine's own tests say. A case reads as the terminal
// command will: the service's answer wrapped the way the verb prints it.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import * as Config from "../src/Config.ts";
import { type Engine, goSm, type Sandbox, sandbox } from "./lib/sandbox.ts";

// A cold build of cli/ takes longer than a test's timeout.
beforeAll(() => {
  goSm();
}, 300_000);

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// The file marker the JSON documents carry, which the store has no use
// for: `config read` prints the file as stored, marker included.
const withoutFileMarker = (doc: unknown) => {
  const { config, ...rest } = doc as { config: unknown };
  if (typeof config !== "object" || config === null) return doc;
  const { schemaVersion: _, ...stored } = config as Record<string, unknown>;
  return { ...rest, config: stored };
};

const same = async (
  go: ReadonlyArray<string>,
  engine: Effect.Effect<unknown, unknown, Engine>,
  normalize: (doc: unknown) => unknown = (doc) => doc,
) =>
  assert.deepStrictEqual(
    await box.engine(engine),
    normalize(await box.go(...go)),
  );

// Steps that each read what the one before left, run one after another.
const inTurn = (steps: ReadonlyArray<() => Promise<void>>) =>
  steps.reduce<Promise<void>>(
    (done, step) => done.then(step),
    Promise.resolve(),
  );

// One scope's verbs, each as the engine's call and the Go command line.
// A project's documents name the project; its errors don't.
const verbs = (scope: Config.ConfigScope) => {
  const [command, flags] =
    scope.kind === "device"
      ? [["config"], []]
      : [
          ["projects", "config"],
          ["-p", "repo"],
        ];
  const answer = <A extends object>(
    run: (config: Config.Config["Service"]) => Effect.Effect<A, unknown>,
  ) =>
    Effect.service(Config.Config).pipe(
      Effect.flatMap(run),
      Effect.map((doc) =>
        scope.kind === "device"
          ? { ok: true, ...doc }
          : { ok: true, ...doc, project: "repo" },
      ),
    );
  const verb = <A extends object>(
    args: ReadonlyArray<string>,
    run: (config: Config.Config["Service"]) => Effect.Effect<A, unknown>,
    normalize?: (doc: unknown) => unknown,
  ) => same([...command, ...args, ...flags], answer(run), normalize);
  return {
    list: () =>
      verb(["list"], (c) =>
        Effect.map(c.list(scope), (settings) => ({ settings })),
      ),
    get: (key: string) => verb(["get", key], (c) => c.get(scope, key)),
    read: () =>
      verb(
        ["read"],
        (c) => Effect.map(c.read(scope), (stored) => ({ config: stored })),
        withoutFileMarker,
      ),
    set: (key: string, raw: string) =>
      verb(["set", key, raw], (c) =>
        Effect.map(c.set(scope, key, raw), (value) =>
          value === undefined ? { key } : { key, value },
        ),
      ),
    unset: (key: string) =>
      verb(["unset", key], (c) => Effect.as(c.unset(scope, key), { key })),
    write: (payload: Record<string, unknown>) =>
      same(
        [...command, "write", "--data", JSON.stringify(payload), ...flags],
        Effect.service(Config.Config).pipe(
          Effect.flatMap((c) => c.write(scope, payload)),
          Effect.as({ ok: true }),
        ),
      ),
  };
};

describe("config", () => {
  const device = verbs({ kind: "device" });

  it("lists, gets and reads a fresh install's settings", async () => {
    await device.list();
    await device.get("doubutsuNames");
    await device.read();
  });

  it("lists, gets and reads stored settings, keys it doesn't model kept", async () => {
    box.write("config.json", {
      deleteBranchOnRemove: false,
      launchers: [{ id: "a", label: "A", command: "a" }],
      hiddenLaunchers: ["app:cursor"],
      directConnections: false,
      theme: "dark",
      schemaVersion: 1,
    });
    box.write("registry.json", { projects: [] });
    await device.list();
    await device.get("launchers");
    await device.get("githubCli");
    await device.read();
  });

  it("refuses a key it doesn't model, pointing appearance keys at the app", async () => {
    await device.get("nope");
    await device.get("theme");
  });

  it("sets from text forms, storing a default by removing the key", async () => {
    box.write("config.json", { deleteBranchOnRemove: false });
    box.write("registry.json", { projects: [] });
    await inTurn([
      () => device.set("portPool", "on"),
      () => device.set("deleteBranchOnRemove", "YES"),
      () => device.set("terrier", "0"),
      () => device.set("autoPullNew", "maybe"),
      () => device.read(),
    ]);
  });

  it("unsets, and writes a whole document the way the app saves", async () => {
    box.write("config.json", {
      portPool: true,
      githubCli: false,
      fromNewerBuild: 1,
    });
    box.write("registry.json", { projects: [] });
    await inTurn([
      () => device.unset("portPool"),
      () => device.unset("nope"),
      () =>
        device.write({
          launchScripts: false,
          launchers: [{ id: "b", label: "B", command: "b" }],
          directConnections: null,
        }),
      () => device.read(),
      () => device.write({ launchScripts: "yes" }),
      () => device.write({ launchers: [{ id: "a", label: " " }] }),
      () => device.write({ hiddenLaunchers: [1] }),
      () => device.read(),
    ]);
  });
});

describe("projects config", () => {
  const project = verbs({ kind: "project", projectId: "P1" });
  const register = (configured?: unknown) => {
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: `${box.home}/repo` }],
    });
    if (configured !== undefined) {
      box.write("projects/P1/project.json", configured);
    }
  };

  it("lists, gets and reads a configured project, nested keys included", async () => {
    register({
      defaultBranch: "main",
      scripts: { setup: "pnpm i" },
      carryOver: [{ path: ".env", mode: "copy" }],
      fromNewerBuild: true,
      schemaVersion: 1,
    });
    await project.list();
    await Promise.all(
      ["scripts.setup", "scripts.teardown", "carryOver"].map((key) =>
        project.get(key),
      ),
    );
    await project.read();
  });

  it("reads an unconfigured project as null and lists its defaults", async () => {
    register();
    await project.read();
    await project.list();
  });

  it("merges a whole document into nested objects, dropping one its nulls empty", async () => {
    register({
      defaultBranch: "main",
      scripts: { setup: "pnpm i", teardown: "x", fromNewerBuild: 1 },
      portBase: 4000,
    });
    await inTurn([
      () =>
        project.write({
          defaultBranch: "main",
          scripts: { setup: null, teardown: null },
          portBase: null,
        }),
      () => project.read(),
      () => project.set("scripts.setup", "bun i"),
      () => project.set("scripts.setup", ""),
      () => project.set("customWorktreePath", "~/trees/"),
      () => project.set("customWorktreePath", "trees"),
      () => project.set("portBase", "0"),
      () => project.unset("defaultBranch"),
      () => project.write({ defaultBranch: "  " }),
      () => project.write({ defaultBranch: "main", worktreeLayout: 1 }),
      () =>
        project.write({
          defaultBranch: "main",
          carryOver: [{ path: "../out", mode: "copy" }],
        }),
      () => project.read(),
    ]);
  });
});
