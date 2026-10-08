// The parity harness: each verb the engine can answer, run as the Go
// `sm --json` and as the engine's service call against copies of one
// sandbox, and the two documents compared. The CLI's surface is frozen
// (V3.md, decision 13), so a difference here is a bug in the engine,
// whatever the engine's own tests say. A case reads as the terminal
// command will: the service's answer wrapped the way the verb prints it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Icons from "../src/Icons.ts";
import * as Launchers from "../src/Launchers.ts";
import * as Registry from "../src/Registry.ts";
import * as Scripts from "../src/Scripts.ts";
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
  cwd = box.home,
) =>
  assert.deepStrictEqual(
    await box.engine(engine),
    normalize(await box.goAt(cwd, ...go)),
  );

// Steps that each read what the one before left, run one after another.
const inTurn = (steps: ReadonlyArray<() => Promise<void>>) =>
  steps.reduce<Promise<void>>(
    (done, step) => done.then(step),
    Promise.resolve(),
  );

// One scope's verbs, each as the engine's call and the Go command line.
// A project's documents name the project, and its errors don't. The
// project is "repo" (P1) at <home>/repo.
const verbs = (kind: Config.ConfigScope["kind"]) => {
  const device = kind === "device";
  const scopeOf = (): Config.ConfigScope =>
    device
      ? { kind: "device" }
      : { kind: "project", projectId: "P1", path: `${box.home}/repo` };
  const [command, flags] = device
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
        device ? { ok: true, ...doc } : { ok: true, ...doc, project: "repo" },
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
        Effect.map(c.list(scopeOf()), (settings) => ({ settings })),
      ),
    get: (key: string) => verb(["get", key], (c) => c.get(scopeOf(), key)),
    read: () =>
      verb(
        ["read"],
        (c) => Effect.map(c.read(scopeOf()), (stored) => ({ config: stored })),
        withoutFileMarker,
      ),
    set: (key: string, raw: string) =>
      verb(["set", key, raw], (c) =>
        Effect.map(c.set(scopeOf(), key, raw), (value) =>
          value === undefined ? { key } : { key, value },
        ),
      ),
    unset: (key: string) =>
      verb(["unset", key], (c) => Effect.as(c.unset(scopeOf(), key), { key })),
    write: (payload: Record<string, unknown>) =>
      same(
        [...command, "write", "--data", JSON.stringify(payload), ...flags],
        Effect.service(Config.Config).pipe(
          Effect.flatMap((c) => c.write(scopeOf(), payload)),
          Effect.as({ ok: true }),
        ),
      ),
  };
};

describe("config", () => {
  const device = verbs("device");

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
  const project = verbs("project");
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

describe("launchers", () => {
  it("lists the catalog, installed or not, by label", async () => {
    await same(
      ["launchers", "--catalog"],
      Effect.service(Launchers.Launchers).pipe(
        Effect.flatMap((launchers) => launchers.catalog),
        Effect.map((apps) => ({ ok: true, apps })),
      ),
    );
  });
});

describe("run", () => {
  it("lists a worktree's scripts with the manager, use stats, sort and order", async () => {
    const recent = Date.now() - 60_000;
    const repo = box.repo("repo", {
      "package.json": JSON.stringify({
        scripts: { dev: "vite", "2": "two", lint: "oxlint", n: 1 },
      }),
      "pnpm-lock.yaml": "",
    });
    box.write("registry.json", {
      projects: [{ id: "P", name: "repo", path: repo }],
    });
    box.write("state.json", {
      packageScriptUseLog: { P: { dev: [1000, recent], gone: [recent] } },
      packageScriptSort: { P: "manual" },
      packageScriptOrder: { P: ["lint", "missing", "dev"] },
    });
    await same(
      ["run"],
      Effect.service(Scripts.Scripts).pipe(
        Effect.flatMap((scripts) =>
          scripts.list({ projectId: "P", worktreePath: repo }),
        ),
        Effect.map((listed) => Object.assign({ ok: true }, listed)),
      ),
      undefined,
      repo,
    );
  });
});

describe("projects config writes", () => {
  it("fills a missing default branch from git", async () => {
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
    });
    const project = verbs("project");
    await inTurn([() => project.set("portBase", "4100"), () => project.read()]);
  });
});

// The Go sm still works out an accent hue from the icon, which the
// engine drops (V3.md, decision 12).
const withoutHue = (doc: unknown) =>
  (doc as Record<string, unknown>[]).map((row) =>
    Object.assign({}, row, { hue: null }),
  );

describe("projects list", () => {
  const list = Effect.service(Registry.Registry).pipe(
    Effect.flatMap((registry) => registry.rows()),
  );

  it("lists in the manual order, with paths, identities, remotes and use", async () => {
    const recent = Date.now() - 60_000;
    const alpha = box.repo("alpha");
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Me/Alpha.git"],
      {
        cwd: alpha,
      },
    );
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
        { id: "G", name: "gone", path: `${box.home}/gone` },
      ],
      projectOrder: [beta, `${box.home}/elsewhere`, alpha],
    });
    box.write("state.json", { projectUseLog: { A: [1000, recent], G: [5] } });
    await same(["projects", "list"], list, withoutHue);
  });

  // The scenarios the repo-identity fixture pins, each repo built with
  // fixed dates so its root commit's sha is the fixture's literal.
  it("gives each identity scenario's repo the fixture's identity", async () => {
    type Scenario = {
      name: string;
      repos: { dir: string; git: string[][] }[];
      checks: { dir: string; expected: string | null }[];
    };
    const scenarios = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../app/shared/fixtures/repo-identity-scenarios.json",
        ),
        "utf8",
      ),
    ) as Scenario[];
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "2005-04-07T22:13:13+0000",
      GIT_COMMITTER_DATE: "2005-04-07T22:13:13+0000",
      LC_ALL: "C",
    };
    const checks = scenarios.flatMap((scenario) => {
      const root = join(box.home, scenario.name.replace(/[^\w-]+/g, "-"));
      for (const repo of scenario.repos) {
        const dir = join(root, repo.dir);
        mkdirSync(dir, { recursive: true });
        for (const args of repo.git) {
          execFileSync(
            "git",
            args.map((arg) => arg.replaceAll("{{root}}", root)),
            { cwd: dir, env, stdio: "ignore" },
          );
        }
      }
      return scenario.checks.map(({ dir, expected }) => ({
        path: join(root, dir),
        expected,
      }));
    });
    box.write("registry.json", {
      projects: checks.map(({ path }, index) => ({
        id: `P${index}`,
        name: `p${index}`,
        path,
      })),
    });
    await same(["projects", "list"], list, withoutHue);
    const rows = (await box.engine(list)) as { identity: string | null }[];
    assert.deepEqual(
      rows.map((row) => row.identity),
      checks.map(({ expected }) => expected),
    );
  });

  it("finds each project's icon: conventional files, package roots, icon links", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#e33"/></svg>';
    const atRoot = box.repo("at-root", { "public/favicon.svg": svg });
    const inPackage = box.repo("in-package", {
      "package.json": "{}",
      "web/package.json": "{}",
      "web/assets/icon.svg": svg,
    });
    const linked = box.repo("linked", {
      "index.html": '<link rel="icon" href="/brand/mark.svg?v=2">',
      "public/brand/mark.svg": svg,
    });
    const ignored = box.repo("ignored", {
      ".gitignore": "dist\n",
      "dist/favicon.svg": svg,
    });
    const none = box.repo("none");
    box.write("registry.json", {
      projects: [atRoot, inPackage, linked, ignored, none].map(
        (path, index) => ({ id: `P${index}`, name: `p${index}`, path }),
      ),
    });
    await same(["projects", "list"], list, withoutHue);
    const rows = (await box.engine(list)) as {
      icon: { path: string } | null;
    }[];
    assert.deepEqual(
      rows.map(({ icon }) => icon?.path.slice(box.home.length) ?? null),
      [
        "/at-root/public/favicon.svg",
        "/in-package/web/assets/icon.svg",
        "/linked/public/brand/mark.svg",
        null,
        null,
      ],
    );
    await same(
      ["projects", "icon", "-p", "p2"],
      Effect.service(Icons.Icons).pipe(
        Effect.flatMap((icons) => icons.bytes(linked)),
        Effect.map(Option.getOrNull),
      ),
    );
  });
});

describe("projects list with terrier", () => {
  // A terrier on PATH that answers as `version` and `ls --json` do.
  const fakeTerrier = (version: string, paths: ReadonlyArray<string>) =>
    box.fakeBin(
      "terrier",
      `if [ "$1" = version ]; then echo ${version}; else echo '${JSON.stringify(
        { projects: paths.map((path) => ({ path })) },
      )}'; fi`,
    );
  const list = Effect.service(Registry.Registry).pipe(
    Effect.flatMap((registry) => registry.rows()),
  );

  it("adds terrier's repos the registry doesn't hold, read-only, by name", async () => {
    const both = box.repo("both");
    const extra = box.repo("zeta");
    fakeTerrier("v0.1.4", [
      `${extra}/`,
      both,
      "relative/path",
      `${box.home}/alpha-gone`,
    ]);
    box.write("config.json", { terrier: true });
    box.write("registry.json", {
      projects: [{ id: "B", name: "both", path: both }],
    });
    await same(["projects", "list"], list, withoutHue);
  });

  it("lists none of terrier's while its version isn't one this build reads", async () => {
    fakeTerrier("v0.2.0", [box.repo("zeta")]);
    box.write("config.json", { terrier: true });
    box.write("registry.json", { projects: [] });
    await same(["projects", "list"], list, withoutHue);
    assert.deepEqual(await box.engine(list), []);
  });
});

describe("launchers", () => {
  it("lists a project's row: installed apps, its GitHub page, custom ones, by use", async () => {
    const recent = Date.now() - 60_000;
    const repo = box.repo("repo");
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/Me/Repo.git"],
      { cwd: repo },
    );
    box.write("registry.json", {
      projects: [{ id: "P", name: "repo", path: repo }],
    });
    box.write("config.json", {
      launchers: [
        { id: "a", label: "zsh here", command: "zsh" },
        { label: "no id", command: "x" },
      ],
      hiddenLaunchers: ["app:finder", "custom:gone"],
    });
    box.write("projects/P/project.json", {
      defaultBranch: "main",
      launchers: [{ id: "b", label: "Agent", command: "claude" }],
    });
    box.write("state.json", {
      launcherUseLog: {
        "custom:a": [1, recent, recent],
        "web:github": [recent],
      },
    });
    await same(
      ["launchers", "-p", "repo"],
      Effect.service(Launchers.Launchers).pipe(
        Effect.flatMap((launchers) => launchers.row({ id: "P", path: repo })),
        Effect.map((row) => Object.assign({ ok: true }, row)),
      ),
    );
    const row = (await box.engine(
      Effect.flatMap(Effect.service(Launchers.Launchers), (launchers) =>
        launchers.row({ id: "P", path: repo }),
      ),
    )) as Launchers.LauncherRow;
    assert.deepEqual(
      [row.entries.slice(0, 2).map(({ id }) => id), row.hiddenCount],
      [["custom:a", "web:github"], 1],
    );
    assert.ok(row.entries.some(({ id }) => id === "custom:b"));
  });
});
