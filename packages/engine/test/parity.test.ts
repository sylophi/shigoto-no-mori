// The parity harness: each verb the engine can answer, run as the Go
// `sm --json` and as the engine's service call against copies of one
// sandbox, and the two documents compared. The CLI's surface is frozen
// (V3.md, decision 13), so a difference here is a bug in the engine,
// whatever the engine's own tests say. A case reads as the terminal
// command will: the service's answer wrapped the way the verb prints it.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as Config from "../src/Config.ts";
import { type Engine, type Sandbox, sandbox } from "./lib/sandbox.ts";

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
  go: string[],
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

const device = { kind: "device" } as const;
const config = Effect.service(Config.Config);

const list = config.pipe(
  Effect.flatMap((c) => c.list(device)),
  Effect.map((settings) => ({ ok: true, settings })),
);
const get = (key: string) =>
  config.pipe(
    Effect.flatMap((c) => c.get(device, key)),
    Effect.map((setting) => ({ ok: true, ...setting })),
  );
const read = config.pipe(
  Effect.flatMap((c) => c.read(device)),
  Effect.map((stored) => ({ ok: true, config: stored })),
);
const set = (key: string, raw: string) =>
  config.pipe(
    Effect.flatMap((c) => c.set(device, key, raw)),
    Effect.map((value) => ({ ok: true, key, value })),
  );
const unset = (key: string) =>
  config.pipe(
    Effect.flatMap((c) => c.unset(device, key)),
    Effect.as({ ok: true, key }),
  );
const write = (payload: Record<string, unknown>) =>
  config.pipe(
    Effect.flatMap((c) => c.write(device, payload)),
    Effect.as({ ok: true }),
  );

describe("config", () => {
  it("lists, gets and reads a fresh install's settings", async () => {
    await same(["config", "list"], list);
    await same(["config", "get", "doubutsuNames"], get("doubutsuNames"));
    await same(["config", "read"], read, withoutFileMarker);
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
    await same(["config", "list"], list);
    await same(["config", "get", "launchers"], get("launchers"));
    await same(["config", "get", "githubCli"], get("githubCli"));
    await same(["config", "read"], read, withoutFileMarker);
  });

  it("refuses a key it doesn't model, pointing appearance keys at the app", async () => {
    await same(["config", "get", "nope"], get("nope"));
    await same(["config", "get", "theme"], get("theme"));
  });

  it("sets from text forms, storing a default by removing the key", async () => {
    box.write("config.json", { deleteBranchOnRemove: false });
    box.write("registry.json", { projects: [] });
    await inTurn(
      [
        ["portPool", "on"],
        ["deleteBranchOnRemove", "YES"],
        ["terrier", "0"],
        ["autoPullNew", "maybe"],
      ].map(
        ([key = "", raw = ""]) =>
          () =>
            same(["config", "set", key, raw], set(key, raw)),
      ),
    );
    await same(["config", "read"], read, withoutFileMarker);
  });

  it("unsets, and writes a whole document the way the app saves", async () => {
    box.write("config.json", {
      portPool: true,
      githubCli: false,
      fromNewerBuild: 1,
    });
    box.write("registry.json", { projects: [] });
    await same(["config", "unset", "portPool"], unset("portPool"));
    await same(["config", "unset", "nope"], unset("nope"));
    const payload = {
      launchScripts: false,
      launchers: [{ id: "b", label: "B", command: "b" }],
      directConnections: null,
    };
    await same(
      ["config", "write", "--data", JSON.stringify(payload)],
      write(payload),
    );
    await same(["config", "read"], read, withoutFileMarker);
    const wrong = { launchScripts: "yes" };
    await same(
      ["config", "write", "--data", JSON.stringify(wrong)],
      write(wrong),
    );
  });
});

// A project-scoped verb's document names the project.
const scoped = <A extends object>(
  run: Effect.Effect<A, unknown, Config.Config>,
) => Effect.map(run, (doc) => ({ ...doc, project: "repo" }));

describe("projects config", () => {
  const project = { kind: "project", projectId: "P1" } as const;
  const register = (configured: unknown) => {
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
    await same(
      ["projects", "config", "list", "-p", "repo"],
      scoped(
        config.pipe(
          Effect.flatMap((c) => c.list(project)),
          Effect.map((settings) => ({ ok: true, settings })),
        ),
      ),
    );
    await Promise.all(
      ["scripts.setup", "scripts.teardown", "carryOver"].map((key) =>
        same(
          ["projects", "config", "get", key, "-p", "repo"],
          scoped(
            config.pipe(
              Effect.flatMap((c) => c.get(project, key)),
              Effect.map((setting) => ({ ok: true, ...setting })),
            ),
          ),
        ),
      ),
    );
    await same(
      ["projects", "config", "read", "-p", "repo"],
      scoped(
        config.pipe(
          Effect.flatMap((c) => c.read(project)),
          Effect.map((stored) => ({ ok: true, config: stored })),
        ),
      ),
      withoutFileMarker,
    );
  });

  it("reads an unconfigured project as null and lists its defaults", async () => {
    register(undefined);
    await same(
      ["projects", "config", "read", "-p", "repo"],
      scoped(
        config.pipe(
          Effect.flatMap((c) => c.read(project)),
          Effect.map((stored) => ({ ok: true, config: stored })),
        ),
      ),
    );
    await same(
      ["projects", "config", "list", "-p", "repo"],
      scoped(
        config.pipe(
          Effect.flatMap((c) => c.list(project)),
          Effect.map((settings) => ({ ok: true, settings })),
        ),
      ),
    );
  });
});
