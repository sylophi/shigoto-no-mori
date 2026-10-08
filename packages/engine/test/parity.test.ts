// The parity harness: each verb the engine can answer, run as the Go
// `sm --json` and as the engine's service call against copies of one
// sandbox, and the two documents compared. The CLI's surface is frozen
// (V3.md, decision 13), so a difference here is a bug in the engine,
// whatever the engine's own tests say. A case reads as the terminal
// command will: the service's answer wrapped the way the verb prints it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "vitest";
import * as Config from "../src/Config.ts";
import { errorDocument } from "../src/errorDocument.ts";
import type { Flavor } from "../src/flavor.ts";
import * as Doctor from "../src/Doctor.ts";
import type * as GitHub from "../src/GitHub.ts";
import * as Landing from "../src/Landing.ts";
import * as Hygiene from "../src/Hygiene.ts";
import * as Icons from "../src/Icons.ts";
import * as Launchers from "../src/Launchers.ts";
import * as Paths from "../src/Paths.ts";
import * as Registry from "../src/Registry.ts";
import type { RegisteredProject } from "../src/Registry.ts";
import * as Scripts from "../src/Scripts.ts";
import * as Updater from "../src/Updater.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import * as Worktrees from "../src/Worktrees.ts";
import {
  type Engine,
  goSm,
  goSmRelease,
  type Sandbox,
  sandbox,
} from "./lib/sandbox.ts";

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
) => {
  assert.deepStrictEqual(
    await box.engine(engine),
    normalize(await box.goAt(cwd, ...go)),
  );
};

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

// --- worktrees ----------------------------------------------------------

// The worktree verbs as the terminal will run them: where the command
// runs, then the service call. A project "repo" (P1) with its linked
// worktrees under the in-project base, managed for both sides whatever
// data dir each has.
const worktrees = Effect.service(Worktrees.Worktrees);

const hereAt = (cwd: string) =>
  worktrees.pipe(Effect.flatMap((service) => service.here(cwd)));

// The worktree a verb names, then what the verb does with it.
const onTarget = <A, E>(
  cwd: string,
  target: Worktrees.Target,
  run: (
    service: Worktrees.Worktrees["Service"],
    located: Worktrees.Located,
  ) => Effect.Effect<A, E, Engine>,
) =>
  Effect.gen(function* () {
    const service = yield* worktrees;
    const here = yield* service.here(cwd);
    return yield* run(service, yield* service.resolve(here, target));
  });

const seedProject = (files: Record<string, string> = { "a.txt": "a\n" }) => {
  const repo = box.repo("repo", files);
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  const tree = (name: string, ...base: string[]) => {
    const path = join(repo, ".shigomori", "worktrees", name);
    box.git(repo, "worktree", "add", "-q", "-b", name, path, ...base);
    return path;
  };
  return { repo, tree };
};

// A gh on PATH that answers `pr list` with `prs`, or fails with
// `stderr`, for both sides. The engine reads PATH when its runtime is
// first built, so this goes before any engine call.
const fakeGh = (answer: { prs?: unknown[]; stderr?: string }) =>
  box.fakeBin(
    "gh",
    answer.stderr === undefined
      ? `cat <<'JSON'\n${JSON.stringify(answer.prs ?? [])}\nJSON`
      : `echo ${JSON.stringify(answer.stderr)} >&2\nexit 1`,
  );

describe("worktrees list", () => {
  it("lists the project at the cwd, primary first, with sync, changes, commits and marks", async () => {
    const { repo, tree } = seedProject();
    const fox = tree("fox");
    const owl = tree("owl");
    writeFileSync(join(fox, "a.txt"), "edited\n");
    writeFileSync(join(fox, "new.txt"), "new\n");
    box.git(owl, "commit", "-q", "--allow-empty", "-m", "owl's own");
    box.git(repo, "checkout", "-q", "--detach");
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
      autoPullWorktrees: { [worktreeIdFromPath(repo)]: true },
    });
    const list = (cwd: string) =>
      same(
        ["worktrees", "list"],
        Effect.gen(function* () {
          const here = yield* hereAt(cwd);
          const scope = here.current ? [here.current.project] : here.projects;
          return (yield* (yield* worktrees).list(scope)).rows;
        }),
        undefined,
        cwd,
      );
    await list(fox);
    await list(box.home);
  });

  it("lists identities, with the primary ref when asked", async () => {
    const { repo, tree } = seedProject();
    tree("fox");
    box.git(repo, "remote", "add", "origin", "git@github.com:me/repo.git");
    box.git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    for (const primaryRef of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one shape at a time
      await same(
        [
          "worktrees",
          "list",
          "--identities",
          ...(primaryRef ? ["--primary-ref"] : []),
        ],
        Effect.gen(function* () {
          const here = yield* hereAt(repo);
          return (yield* (yield* worktrees).identityList(here.projects, {
            primaryRef,
          })).rows;
        }),
        undefined,
        repo,
      );
    }
  });

  it("settles the shelf: a snapshot first, then unshelved once worked in", async () => {
    const { repo, tree } = seedProject();
    const fox = tree("fox");
    const owl = tree("owl");
    const shelved = {
      [worktreeIdFromPath(fox)]: true,
      [worktreeIdFromPath(owl)]: true,
    };
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
      shelvedWorktrees: shelved,
    });
    const list = () =>
      same(
        ["worktrees", "list", "-p", "repo"],
        worktrees.pipe(
          Effect.flatMap((service) =>
            service.list([{ id: "P1", name: "repo", path: repo }]),
          ),
          Effect.map(({ rows }) => rows),
        ),
      );
    await list();
    box.git(fox, "commit", "-q", "--allow-empty", "-m", "worked");
    await list();
    await list();
  });

  it("lists one worktree by id, and refuses an unknown one with its code", async () => {
    const { tree } = seedProject();
    const fox = tree("fox");
    const byId = (worktreeId: string) =>
      same(
        ["worktrees", "list", "--worktree-id", worktreeId],
        onTarget(box.home, { worktreeId }, (service, located) =>
          service
            .row(located, { settle: true })
            .pipe(Effect.map((row) => [row])),
        ),
      );
    await byId(worktreeIdFromPath(fox));
    await byId("nope");
  });
});

// Go lists the candidates in the order its lookups finished.
const sortedCandidates = (doc: unknown) => {
  const { error } = doc as { error: string };
  return {
    ...(doc as object),
    error: error.replace(
      /\(([^)]*)\)/,
      (_, list: string) => `(${list.split(", ").toSorted().join(", ")})`,
    ),
  };
};

describe("worktrees path", () => {
  it("resolves names, paths, <project>/<name>, the reserved names and the cwd, and says why it can't", async () => {
    const { repo, tree } = seedProject();
    const fox = tree("fox");
    mkdirSync(join(box.home, "plain"));
    const path = (cwd: string, ...args: string[]) =>
      same(
        ["worktrees", "path", ...args],
        onTarget(
          cwd,
          {
            ref: args.find((arg) => !arg.startsWith("-") && arg !== "repo"),
            project: args.includes("-p") ? "repo" : undefined,
          },
          (_, { project, worktree }) =>
            Effect.succeed({
              id: worktree.id,
              name: worktree.name,
              branch: worktree.branch,
              path: worktree.path,
              projectName: project.name,
              projectId: project.id,
              isPrimary: worktree.isPrimary,
            }),
        ),
        undefined,
        cwd,
      );
    await path(box.home, "fox");
    await path(box.home, "FOX");
    await path(box.home, "repo/fox");
    await path(box.home, "root");
    await path(box.home, "repo/primary");
    await path(fox);
    await path(join(fox, "."), ".");
    await path(box.home, fox);
    await path(repo, "-p", "repo");
    await path(box.home, "-p", "repo");
    await path(box.home, "nope");
    await path(box.home, "repo/nope");
    await path(box.home, "other/fox");
    await path(box.home);
    await path(join(box.home, "plain"), join(box.home, "plain"));
  });

  it("finds a name in several projects ambiguous, and the reserved names need a project", async () => {
    const one = box.repo("one");
    const two = box.repo("two");
    for (const repo of [one, two]) {
      box.git(
        repo,
        "worktree",
        "add",
        "-q",
        "-b",
        "fox",
        join(repo, ".shigomori", "worktrees", "fox"),
      );
    }
    box.write("registry.json", {
      projects: [
        { id: "A", name: "one", path: one },
        { id: "B", name: "two", path: two },
      ],
    });
    for (const ref of ["fox", "root"]) {
      // oxlint-disable-next-line no-await-in-loop -- one ref at a time
      await same(
        ["worktrees", "path", ref],
        onTarget(box.home, { ref }, (_, located) =>
          Effect.succeed(located.worktree.path),
        ),
        sortedCandidates,
      );
    }
  });
});

describe("worktrees status", () => {
  it("cards a worktree: upstream, base, change counts, stash, last commit, scripts, ports", async () => {
    const { repo, tree } = seedProject({ "a.txt": "a\n", "b.txt": "b\n" });
    box.write("projects/P1/project.json", {
      defaultBranch: "main",
      scripts: { setup: "pnpm i" },
    });
    const fox = tree("fox");
    box.git(fox, "commit", "-q", "--allow-empty", "-m", "ahead");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "moved on");
    writeFileSync(join(fox, "a.txt"), "staged\n");
    box.git(fox, "add", "a.txt");
    writeFileSync(join(fox, "a.txt"), "staged, then edited\n");
    writeFileSync(join(fox, "b.txt"), "unstaged\n");
    writeFileSync(join(fox, "c.txt"), "untracked\n");
    writeFileSync(
      join(fox, "port-pool.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        portNames: ["web", "api"],
        envFiles: { ".env": { PORT: "${web}", API: "${api}", URL: "x${web}" } },
      }),
    );
    writeFileSync(join(fox, ".env"), "PORT=4100\nexport API='4101'\n");
    box.git(repo, "stash", "list");
    const status = (...args: string[]) =>
      same(
        ["worktrees", "status", "fox", ...args],
        onTarget(box.home, { ref: "fox" }, (service, located) =>
          service.status(located, { pullRequest: !args.includes("--no-pr") }),
        ),
      );
    await status("--no-pr");
    box.git(fox, "branch", "--set-upstream-to", "main");
    await status("--no-pr");
  });

  it("cards the pull request gh finds, skipping a stranger's fork", async () => {
    fakeGh({
      prs: [
        { number: 9, title: "fork", state: "OPEN", isCrossRepository: true },
        {
          number: 7,
          title: "Mine",
          state: "OPEN",
          isDraft: false,
          url: "https://github.com/me/repo/pull/7",
          baseRefName: "main",
          headRefName: "fox",
          isCrossRepository: false,
          autoMergeRequest: { mergeMethod: "SQUASH" },
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { status: "IN_PROGRESS", conclusion: "" },
            { state: "FAILURE" },
          ],
        },
      ],
    });
    seedProject().tree("fox");
    await same(
      ["worktrees", "status", "fox"],
      onTarget(box.home, { ref: "fox" }, (service, located) =>
        service.status(located, { pullRequest: true }),
      ),
    );
  });

  it("says why the pull request couldn't be looked up", async () => {
    fakeGh({
      stderr:
        "none of the git remotes configured for this repository point to a known GitHub host",
    });
    seedProject().tree("fox");
    await same(
      ["worktrees", "status", "fox"],
      onTarget(box.home, { ref: "fox" }, (service, located) =>
        service.status(located, { pullRequest: true }),
      ),
    );
  });
});

describe("worktrees marks", () => {
  it("shelves and unshelves a managed worktree, refusing the primary and an external", async () => {
    const { repo, tree } = seedProject();
    tree("fox");
    const outside = join(box.home, "outside");
    box.git(repo, "worktree", "add", "-q", "-b", "outside", outside);
    const shelve = (ref: string, on: boolean) =>
      same(
        ["worktrees", on ? "shelve" : "unshelve", ref],
        onTarget(box.home, { ref }, (service, { worktree }) =>
          service.setShelved(worktree, on).pipe(
            Effect.as({
              ok: true,
              name: worktree.name,
              id: worktree.id,
              shelved: on,
            }),
          ),
        ),
      );
    await inTurn([
      () => shelve("fox", true),
      () => shelve("repo/root", true),
      () => shelve("outside", true),
      () => shelve("fox", false),
      () => shelve("outside", false),
    ]);
  });

  it("sets auto-pull on any checkout and answers the row", async () => {
    const { tree } = seedProject();
    tree("fox");
    const autopull = (ref: string, mode?: "on" | "off") =>
      same(
        ["worktrees", "autopull", ...(mode ? [mode] : []), ref],
        onTarget(box.home, { ref }, (service, located) =>
          Effect.gen(function* () {
            if (mode)
              yield* service.setAutoPull(located.worktree, mode === "on");
            return { ok: true, worktree: yield* service.row(located) };
          }),
        ),
      );
    await inTurn([
      () => autopull("fox", "on"),
      () => autopull("repo/root", "on"),
      () => autopull("fox"),
      () => autopull("fox", "off"),
    ]);
  });
});

describe("worktrees agent-working", () => {
  it("marks a managed worktree as worked in by an agent, refusing the primary and an external", async () => {
    const { repo, tree } = seedProject();
    tree("fox");
    box.git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "outside",
      join(box.home, "outside"),
    );
    const mark = (ref: string, mode?: "on" | "off") =>
      same(
        ["worktrees", "agent-working", ...(mode ? [mode] : []), ref],
        onTarget(box.home, { ref }, (service, located) =>
          Effect.gen(function* () {
            if (mode) {
              yield* service.setAgentWorking(located.worktree, mode === "on");
            }
            return { ok: true, worktree: yield* service.row(located) };
          }),
        ),
      );
    await inTurn([
      () => mark("fox", "on"),
      () => mark("fox"),
      () => mark("repo/root", "on"),
      () => mark("outside", "on"),
      () => mark("outside", "off"),
      () => mark("fox", "off"),
    ]);
    await same(
      ["worktrees", "list", "--identities", "-p", "repo"],
      worktrees.pipe(
        Effect.flatMap((service) =>
          service.identityList([{ id: "P1", name: "repo", path: repo }], {
            primaryRef: false,
          }),
        ),
        Effect.map(({ rows }) => rows),
      ),
    );
  });
});

describe("worktrees describe", () => {
  const describeVerb = (
    ref: string,
    change: { title?: string; description?: string },
  ) =>
    same(
      [
        "worktrees",
        "describe",
        ref,
        ...(change.title === undefined ? [] : ["-t", change.title]),
        ...(change.description === undefined ? [] : ["-d", change.description]),
      ],
      onTarget(
        box.home,
        { ref },
        (service, located): Effect.Effect<object, unknown> =>
          change.title === undefined && change.description === undefined
            ? service
                .description(located)
                .pipe(Effect.map((view) => ({ ok: true, ...view })))
            : service
                .describe(located, change)
                .pipe(Effect.map(({ worktree }) => ({ ok: true, worktree }))),
      ),
    );

  it("sets, keeps and clears the title and description, and refuses what doesn't fit", async () => {
    const { repo, tree } = seedProject();
    tree("fox");
    box.git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "outside",
      join(box.home, "outside"),
    );
    await inTurn([
      () => describeVerb("fox", {}),
      () =>
        describeVerb("fox", {
          title: "  Fix the thing ",
          description: "\n\n  code\nmore  \n\n",
        }),
      () => describeVerb("fox", { title: "Renamed" }),
      // Trimmed as Go trims: a next-line character is space to it.
      () => describeVerb("fox", { title: "Next line\u0085" }),
      () => describeVerb("fox", { title: "Renamed" }),
      () => describeVerb("fox", {}),
      () => describeVerb("fox", { description: "" }),
      () => describeVerb("fox", { title: "tab\there" }),
      () => describeVerb("fox", { title: "x".repeat(257) }),
      () => describeVerb("repo/root", { title: "The primary" }),
      () => describeVerb("outside", { title: "nope" }),
      () => describeVerb("outside", {}),
      () => describeVerb("fox", {}),
    ]);
  });

  it("leaves the title to an open pull request from this repository", async () => {
    fakeGh({
      prs: [
        {
          number: 3,
          url: "u3",
          title: "Fork's",
          body: "",
          isCrossRepository: true,
        },
        {
          number: 4,
          url: "u4",
          title: "Ours",
          body: "Body",
          isCrossRepository: false,
        },
      ],
    });
    const { repo, tree } = seedProject();
    box.git(repo, "remote", "add", "origin", "git@github.com:me/repo.git");
    tree("fox");
    await describeVerb("fox", {});
    await describeVerb("fox", { title: "Mine" });
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

// --- verbs that change the worktrees --------------------------------------

// What differs from run to run, made steady: run ids numbered in order,
// no pids, times as a placeholder, and a script's output joined, since
// each side reads its pipe in chunks of its own.
const steady = (docs: ReadonlyArray<unknown>): unknown[] => {
  const runs = new Map<string, string>();
  const runOf = (id: string) => {
    if (!runs.has(id)) runs.set(id, `run-${runs.size + 1}`);
    return runs.get(id);
  };
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([field]) => field !== "pid")
          .map(([field, item]) => [field, walk(item, field)]),
      );
    }
    if (key === "runId" && typeof value === "string") return runOf(value);
    if (
      (key === "createdAt" || key === "lastChangeAt") &&
      typeof value === "number"
    ) {
      return "<time>";
    }
    return value;
  };
  const joined: Array<Record<string, unknown>> = [];
  for (const doc of docs.map((item) => walk(item) as Record<string, unknown>)) {
    const last = joined.at(-1);
    if (
      doc["kind"] === "data" &&
      last?.["kind"] === "data" &&
      last["runId"] === doc["runId"]
    ) {
      last["data"] = `${String(last["data"])}${String(doc["data"])}`;
    } else {
      joined.push({ ...doc });
    }
  }
  return joined;
};

// A verb that changes the worktrees, run on each side against the same
// starting point, and its documents compared along with `after`, a look
// at what it left. The engine's side reports its events and ends in the
// document the verb prints, or the error it fails with.
const sameChange = async <A, E>(
  go: { readonly args: ReadonlyArray<string>; readonly cwd?: string },
  engine: (reporter: Worktrees.Reporter) => Effect.Effect<A, E, Engine>,
  done: (value: A) => unknown,
  after: () => unknown = () => null,
) => {
  const [goSide, engineSide] = await box.changeBoth(
    async () => ({
      docs: steady(await box.goDocs(go.cwd ?? box.home, ...go.args)),
      after: after(),
    }),
    async () => {
      const events: unknown[] = [];
      const reporter: Worktrees.Reporter = {
        report: (event) => Effect.sync(() => void events.push(event)),
        color: true,
      };
      const last = await box.engine(engine(reporter).pipe(Effect.map(done)));
      return { docs: steady([...events, last]), after: after() };
    },
  );
  assert.deepStrictEqual(engineSide, goSide);
};

// A project configured for the in-project layout, so its new worktrees
// land in the repo both sides share whatever data dir each has.
const inProject = (
  files: Record<string, string> = { "a.txt": "a\n" },
  settings: Record<string, unknown> = {},
) => {
  const seeded = seedProject(files);
  box.write("projects/P1/project.json", {
    defaultBranch: "main",
    worktreeLayout: "in-project",
    ...settings,
  });
  return seeded;
};

const project1 = (repo: string): RegisteredProject => ({
  id: "P1",
  name: "repo",
  path: repo,
});

// The repo's branches and worktrees, as git lists them.
const repoState = (repo: string) => () => ({
  branches: box.git(repo, "branch", "--format=%(refname:short)"),
  worktrees: box.git(repo, "worktree", "list", "--porcelain"),
});

describe("worktrees destination", () => {
  it("says where a new worktree goes and whether the place is taken", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    const destination = (name: string) =>
      same(
        ["worktrees", "destination", "--name", name, "-p", "repo"],
        worktrees.pipe(
          Effect.flatMap((service) =>
            service.destination(project1(repo), name),
          ),
          Effect.map((found) => ({ ok: true, ...found })),
        ),
      );
    mkdirSync(join(repo, ".shigomori", "worktrees", "squatted"));
    await destination("owl");
    await destination("FOX");
    await destination("squatted");
    await destination("primary");
    await destination("a:b");
  });
});

const createVerb = (
  repo: string,
  name: string,
  flags: ReadonlyArray<string> = [],
  input: Parameters<Worktrees.Worktrees["Service"]["create"]>[1] = {},
) =>
  sameChange(
    { args: ["worktrees", "create", name, "--no-cd", "-p", "repo", ...flags] },
    (reporter) =>
      worktrees.pipe(
        Effect.flatMap((service) =>
          service.create(project1(repo), { name, ...input }, reporter),
        ),
      ),
    ({ worktree, failures }) => ({
      event: "done",
      ok: failures.length === 0,
      path: worktree.path,
      worktree,
      failures,
    }),
    repoState(repo),
  );

describe("worktrees create", () => {
  it("makes a worktree on a new branch, from a base, or on an existing branch", async () => {
    const { repo } = inProject();
    box.git(repo, "branch", "existing");
    await createVerb(repo, "fox");
    await createVerb(repo, "owl", ["-b", "feat/owl", "--base", "main"], {
      branch: "feat/owl",
      base: "main",
    });
    await createVerb(repo, "kept", ["--checkout", "--base", "existing"], {
      checkout: true,
      base: "existing",
    });
    await createVerb(repo, "written", ["--no-clone"], { clone: false });
  });

  it("refuses a taken name, an occupied place, a reserved name and checkout without a base", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    mkdirSync(join(repo, ".shigomori", "worktrees", "squatted"));
    await createVerb(repo, "FOX");
    await createVerb(repo, "squatted");
    await createVerb(repo, "root");
    await createVerb(repo, "lone", ["--checkout"], { checkout: true });
  });

  it("marks a new worktree for auto-pull and agent work when asked", async () => {
    const { repo } = inProject();
    box.write("config.json", { autoPullNew: true });
    await createVerb(repo, "fox", ["--agent-working"], { agentWorking: true });
  });

  it("carries files over and runs the setup script, reporting each step", async () => {
    const { repo } = inProject(
      {
        "a.txt": "a\n",
        ".gitignore": ".env\nnode_modules/\nbuild/\n",
        ".worktreeinclude": "build/\n",
      },
      {
        carryOver: [
          { path: ".env", mode: "copy" },
          { path: "node_modules", mode: "symlink" },
          { path: "missing.txt", mode: "copy" },
        ],
        scripts: { setup: 'echo "setting up $SHIGOMORI_WORKTREE_NAME"' },
      },
    );
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "1\n");
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "out.js"), "built\n");
    await createVerb(repo, "fox");
  });

  it("reports a failing setup script and leaves the worktree", async () => {
    const { repo } = inProject(undefined, {
      scripts: { setup: "echo nope >&2; exit 7" },
    });
    await createVerb(repo, "fox");
    await createVerb(repo, "owl", ["--no-setup"], { skipSetup: true });
  });
});

const rmVerb = (
  repo: string,
  ref: string,
  flags: ReadonlyArray<string> = [],
  options: Partial<{
    force: boolean;
    keepBranch: boolean;
    skipCleanup: boolean;
  }> = {},
) =>
  sameChange(
    { args: ["worktrees", "rm", ref, ...flags] },
    (reporter) =>
      onTarget(box.home, { ref }, (service, located) =>
        service
          .remove(
            located,
            {
              force: false,
              keepBranch: false,
              skipCleanup: false,
              ...options,
            },
            reporter,
          )
          .pipe(
            Effect.map((removed) => ({ ok: true, removed })),
            Effect.catchTags({
              CleanupFailed: ({ phase, exitCode, runId }) =>
                Effect.succeed({
                  ok: false,
                  cleanupError: { phase, exitCode, runId },
                }),
            }),
          ),
      ),
    (doc) => doc,
    repoState(repo),
  );

describe("worktrees rm", () => {
  it("removes a worktree and its branch, keeps the branch when asked, refuses the primary", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    tree("owl");
    await rmVerb(repo, "fox");
    await rmVerb(repo, "owl", ["--keep-branch"], { keepBranch: true });
    await rmVerb(repo, "repo/root");
  });

  it("refuses uncommitted changes unless forced, an untracked file included", async () => {
    const { repo, tree } = inProject();
    const fox = tree("fox");
    writeFileSync(join(fox, "new.txt"), "new\n");
    await rmVerb(repo, "fox");
    await rmVerb(repo, "fox", ["-f"], { force: true });
  });

  it("runs the teardown first, keeping the worktree when it fails", async () => {
    const { repo, tree } = inProject(undefined, {
      scripts: {
        teardown: 'echo "tearing down $SHIGOMORI_WORKTREE_NAME"; exit 3',
      },
    });
    tree("fox");
    await rmVerb(repo, "fox");
    await rmVerb(repo, "fox", ["--skip-cleanup"], { skipCleanup: true });
  });

  it("leaves the branch of an external worktree, and its teardown unrun", async () => {
    const { repo } = inProject(undefined, {
      scripts: { teardown: "exit 3" },
    });
    box.git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "outside",
      join(box.home, "outside"),
    );
    await rmVerb(repo, "outside");
  });
});

describe("worktrees move and rekey", () => {
  it("moves a worktree, carrying its title and marks to its new id", async () => {
    const { repo, tree } = inProject();
    const fox = tree("fox");
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
      autoPullWorktrees: { [worktreeIdFromPath(fox)]: true },
    });
    const moveTo = (ref: string, to: string) =>
      sameChange(
        { args: ["worktrees", "move", ref, to] },
        () =>
          onTarget(box.home, { ref }, (service, located) =>
            service.move(located, to),
          ).pipe(Effect.map((moved) => ({ ok: true, ...moved }))),
        (doc) => doc,
        repoState(repo),
      );
    await moveTo("fox", join(repo, ".shigomori", "worktrees", "renamed"));
    mkdirSync(join(box.home, "taken"));
    await moveTo("renamed", join(box.home, "taken"));
    await moveTo("renamed", join(box.home, "elsewhere", "fox"));
    await moveTo("repo/root", join(box.home, "nowhere"));
  });

  it("re-keys ahead of a move", async () => {
    const { repo } = inProject();
    await same(
      [
        "worktrees",
        "rekey",
        "--project-id",
        "P1",
        "--from-id",
        "abc",
        "--to-path",
        join(box.home, "later"),
      ],
      worktrees.pipe(
        Effect.flatMap((service) =>
          service.rekey(project1(repo), "abc", join(box.home, "later")),
        ),
        Effect.map((id) => ({ ok: true, id })),
      ),
    );
  });
});

describe("worktrees adopt and setup", () => {
  const adoptVerb = (repo: string, ref: string, force = false) =>
    sameChange(
      { args: ["worktrees", "adopt", ref, ...(force ? ["-f"] : [])] },
      (reporter) =>
        onTarget(box.home, { ref }, (service, located) =>
          service.adopt(located, { force }, reporter),
        ),
      ({ worktree, failures }) => ({
        event: "done",
        ok: failures.length === 0,
        path: worktree.path,
        worktree,
        failures,
      }),
      repoState(repo),
    );

  it("makes an external worktree managed, refusing a managed one and uncommitted changes", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    const outside = join(box.home, "outside");
    box.git(repo, "worktree", "add", "-q", "-b", "feat/outside", outside);
    await adoptVerb(repo, "fox");
    writeFileSync(join(outside, "new.txt"), "new\n");
    await adoptVerb(repo, outside);
    // Refused too where the user's setting hides untracked files.
    box.git(outside, "config", "status.showUntrackedFiles", "no");
    await adoptVerb(repo, outside);
    await adoptVerb(repo, outside, true);
  });

  const setupVerb = () =>
    sameChange(
      { args: ["worktrees", "setup", "fox"] },
      (reporter) =>
        onTarget(box.home, { ref: "fox" }, (service, located) =>
          service.setup(located, reporter),
        ),
      ({ ran, failures }) =>
        ran.length === 0
          ? { ok: true, ran }
          : { ok: failures.length === 0, ran, failures },
    );

  it("says there is no setup to run", async () => {
    inProject().tree("fox");
    await setupVerb();
  });

  it("runs the setup script again", async () => {
    inProject(undefined, { scripts: { setup: "echo again; exit 2" } }).tree(
      "fox",
    );
    await setupVerb();
  });
});

describe("projects relocate", () => {
  const relocateVerb = (ref: string, to: string) =>
    sameChange(
      { args: ["projects", "relocate", ref, to] },
      () =>
        Effect.gen(function* () {
          const service = yield* worktrees;
          const here = yield* service.here(box.home);
          const project = yield* service.resolveProject(here, ref);
          return yield* service.relocateProject(project, to);
        }),
      (project) => ({ ok: true, project }),
    );

  it("follows a repo renamed by hand, its worktrees and their marks along", async () => {
    const { repo, tree } = inProject();
    const fox = tree("fox");
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
      projectOrder: [repo],
      shelvedWorktrees: { [worktreeIdFromPath(fox)]: true },
    });
    const renamed = join(box.home, "renamed");
    renameSync(repo, renamed);
    await relocateVerb("repo", join(renamed, ".shigomori"));
    await same(
      ["worktrees", "list", "--identities", "--all"],
      worktrees.pipe(
        Effect.flatMap((service) =>
          Effect.flatMap(service.here(box.home), (here) =>
            service.identityList(here.projects, { primaryRef: false }),
          ),
        ),
        Effect.map(({ rows }) => rows),
      ),
    );
  });

  it("refuses a repo that is still there, and a path that is no repo", async () => {
    const { repo } = inProject();
    const other = box.repo("other");
    await relocateVerb("repo", other);
    renameSync(repo, join(box.home, "gone"));
    mkdirSync(join(box.home, "plain"));
    await relocateVerb("repo", join(box.home, "plain"));
  });
});

// --- landing --------------------------------------------------------------

// A gh that answers each call with the first rule whose arguments start
// with the rule's (`*` matches any one), and logs every call. Both sides
// must ask GitHub the same things in the same order, so the log is part
// of what a case compares.
type GhRule = {
  readonly args: ReadonlyArray<string>;
  readonly out?: unknown;
  readonly err?: string;
  readonly code?: number;
};

const scriptedGh = (rules: ReadonlyArray<GhRule>) => {
  const bin = join(box.home, "bin");
  mkdirSync(bin, { recursive: true });
  const rulesFile = join(bin, "gh-rules.json");
  const logFile = join(bin, "gh-calls.log");
  writeFileSync(rulesFile, JSON.stringify(rules));
  writeFileSync(logFile, "");
  writeFileSync(
    join(bin, "fake-gh.mjs"),
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const rules = JSON.parse(readFileSync(${JSON.stringify(rulesFile)}, "utf8"));
const rule = rules.find((r) => r.args.every((a, i) => a === "*" || a === args[i]));
if (!rule) { process.stderr.write("fake gh: unexpected " + args.join(" ")); process.exit(2); }
if (rule.out !== undefined) process.stdout.write(typeof rule.out === "string" ? rule.out : JSON.stringify(rule.out));
if (rule.err !== undefined) process.stderr.write(rule.err);
process.exit(rule.code ?? 0);
`,
  );
  box.fakeBin(
    "gh",
    `exec node ${JSON.stringify(join(bin, "fake-gh.mjs"))} "$@"`,
  );
  // The calls since the last look.
  return () => {
    const calls = readFileSync(logFile, "utf8");
    writeFileSync(logFile, "");
    return calls;
  };
};

const pr = (
  number: number,
  head: string,
  base = "main",
  extra: Record<string, unknown> = {},
) => ({
  number,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  url: `https://github.com/me/repo/pull/${number}`,
  baseRefName: base,
  headRefName: head,
  isCrossRepository: false,
  ...extra,
});

const settingsRule = (
  allowed: { merge?: boolean; squash?: boolean; rebase?: boolean },
  autoMerge = false,
): GhRule => ({
  args: ["api", "graphql", "-F", "owner={owner}"],
  out: {
    data: {
      repository: {
        mergeCommitAllowed: allowed.merge ?? false,
        squashMergeAllowed: allowed.squash ?? false,
        rebaseMergeAllowed: allowed.rebase ?? false,
        autoMergeAllowed: autoMerge,
      },
    },
  },
});

const landing = Effect.service(Landing.Landing);

// A landing verb run on each side, the document, the repo's state and
// the gh calls compared. `merged` events a stack reports come before the
// document, as the terminal prints them.
const sameLanding = <E>(
  args: ReadonlyArray<string>,
  run: (reporter: Landing.Reporter) => Effect.Effect<unknown, E, Engine>,
  repo: string,
  calls: () => string,
) =>
  sameChange(
    { args },
    (reporter) =>
      run({
        ...reporter,
        merged: (event) => reporter.report(event as never),
      }),
    (doc) => doc,
    // Go asks some of these at once, so in no set order.
    () => ({
      ...repoState(repo)(),
      gh: calls()
        .split("\n")
        .filter((line) => line !== "")
        .toSorted(),
    }),
  );

describe("landing", () => {
  it("shows a worktree's pull request", async () => {
    const calls = scriptedGh([
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox")],
      },
    ]);
    const { tree } = inProject();
    tree("fox");
    await same(
      ["worktrees", "pr", "fox"],
      onTarget(box.home, { ref: "fox" }, (_, located) =>
        Effect.flatMap(landing, (service) => service.pullRequest(located)),
      ),
    );
    calls();
  });

  it("merges with the first method allowed, refuses one that isn't, and arms auto-merge where the rules wait", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    const mergeVerb = (
      flags: ReadonlyArray<string>,
      method?: GitHub.MergeMethod,
    ) =>
      sameLanding(
        ["worktrees", "merge", "fox", ...flags],
        (reporter) =>
          onTarget(box.home, { ref: "fox" }, (_, located) =>
            Effect.flatMap(landing, (service) =>
              service.merge({ located }, { method, stack: false }, reporter),
            ),
          ),
        repo,
        calls,
      );
    let calls = scriptedGh([
      settingsRule({ merge: true, squash: true }),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox", "main", { mergeStateStatus: "CLEAN" })],
      },
      { args: ["pr", "merge", "7"], out: "" },
    ]);
    await mergeVerb([]);
    await mergeVerb(["-m", "rebase"], "rebase");
    calls = scriptedGh([
      settingsRule({ squash: true }, true),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox", "main", { mergeStateStatus: "BLOCKED" })],
      },
      { args: ["pr", "merge", "7", "--auto"], out: "" },
      {
        args: ["api", "graphql", "-F", "number=7"],
        out: {
          data: {
            repository: {
              pullRequest: { state: "OPEN", isInMergeQueue: false },
            },
          },
        },
      },
    ]);
    await mergeVerb([]);
  });

  it("merges a pull request by number, refusing a stranger's fork", async () => {
    const { repo } = inProject();
    const calls = scriptedGh([
      settingsRule({ merge: true }),
      { args: ["pr", "view", "7"], out: pr(7, "fox") },
      {
        args: ["pr", "view", "8"],
        out: pr(8, "theirs", "main", { isCrossRepository: true }),
      },
      { args: ["pr", "merge", "7"], out: "" },
    ]);
    const byNumber = (number: number) =>
      sameLanding(
        [
          "worktrees",
          "merge",
          "--project-id",
          "P1",
          "--number",
          String(number),
        ],
        (reporter) =>
          Effect.flatMap(landing, (service) =>
            service.merge(
              { project: { id: "P1", name: "repo", path: repo }, number },
              { stack: false },
              reporter,
            ),
          ),
        repo,
        calls,
      );
    await byNumber(7);
    await byNumber(8);
  });

  const landVerb = (
    repo: string,
    ref: string,
    calls: () => string,
    flags: ReadonlyArray<string> = [],
  ) =>
    sameLanding(
      ["worktrees", "land", ref, ...flags],
      (reporter) =>
        onTarget(box.home, { ref }, (_, located) =>
          Effect.flatMap(landing, (service) =>
            service.land(
              located,
              {
                force: false,
                keepBranch: false,
                skipCleanup: false,
                stack: flags.includes("--stack"),
              },
              reporter,
            ),
          ),
        ),
      repo,
      calls,
    );

  it("lands: merges, then removes the worktree, or only cleans up once merged", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    tree("owl");
    const calls = scriptedGh([
      settingsRule({ squash: true }),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox")],
      },
      {
        args: ["pr", "list", "--state", "all", "--head", "owl"],
        out: [pr(8, "owl", "main", { state: "MERGED" })],
      },
      { args: ["pr", "merge", "7"], out: "" },
    ]);
    await landVerb(repo, "fox", calls);
    await landVerb(repo, "owl", calls);
  });

  it("refuses to land without an open pull request, over local changes, or a stack with a draft", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    tree("owl");
    const dirty = tree("emu");
    tree("yak");
    writeFileSync(join(dirty, "scratch.txt"), "unsaved\n");
    const calls = scriptedGh([
      settingsRule({ merge: true }),
      { args: ["pr", "list", "--state", "all", "--head", "fox"], out: [] },
      {
        args: ["pr", "list", "--state", "all", "--head", "owl"],
        out: [pr(8, "owl", "main", { state: "CLOSED" })],
      },
      {
        args: ["pr", "list", "--state", "all", "--head", "emu"],
        out: [pr(9, "emu")],
      },
      {
        args: ["pr", "list", "--state", "all", "--head", "yak"],
        out: [pr(10, "yak", "gnu")],
      },
      {
        args: ["pr", "list", "--state", "all", "--limit"],
        out: [pr(10, "yak", "gnu"), pr(5, "gnu", "main", { isDraft: true })],
      },
      {
        args: ["api", "repos/{owner}/{repo}/stacks?pull_request=10"],
        err: "gh: Not Found (HTTP 404)",
        code: 1,
      },
    ]);
    await landVerb(repo, "fox", calls);
    await landVerb(repo, "owl", calls);
    await landVerb(repo, "emu", calls);
    await landVerb(repo, "yak", calls, ["--stack"]);
  });

  it("refuses to land a pull request stacked on another open one", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    const calls = scriptedGh([
      settingsRule({ merge: true }),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox", "owl")],
      },
      {
        args: ["pr", "list", "--state", "all", "--head", "owl"],
        out: [pr(6, "owl")],
      },
    ]);
    await landVerb(repo, "fox", calls);
  });

  it("lands a stack one layer at a time, each retargeted at the trunk, and removes every landed worktree", async () => {
    const { repo, tree } = inProject();
    tree("owl");
    tree("fox");
    const calls = scriptedGh([
      settingsRule({ merge: true }),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox", "owl")],
      },
      {
        args: ["pr", "list", "--state", "all", "--limit"],
        out: [pr(7, "fox", "owl"), pr(6, "owl")],
      },
      {
        args: ["api", "repos/{owner}/{repo}/stacks?pull_request=7"],
        err: "gh: Not Found (HTTP 404)",
        code: 1,
      },
      { args: ["pr", "edit", "7"], out: "" },
      {
        args: ["pr", "view", "7", "--json", "mergeStateStatus"],
        out: { mergeStateStatus: "CLEAN" },
      },
      { args: ["pr", "merge"], out: "" },
    ]);
    await landVerb(repo, "fox", calls, ["--stack"]);
  });

  it("merges a stack GitHub knows through its own merge, every layer reported", async () => {
    const { repo, tree } = inProject();
    tree("fox");
    const calls = scriptedGh([
      settingsRule({ squash: true }),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox", "owl")],
      },
      {
        args: ["pr", "list", "--state", "all", "--limit"],
        out: [pr(7, "fox", "owl"), pr(6, "owl")],
      },
      {
        args: ["api", "repos/{owner}/{repo}/stacks?pull_request=7"],
        out: [
          {
            pull_requests: [
              { number: 6, state: "open" },
              { number: 7, state: "open" },
            ],
          },
        ],
      },
      {
        args: ["api", "-X", "PUT"],
        out: { status: "merged", details: { uuid: "u" } },
      },
    ]);
    await sameLanding(
      ["worktrees", "merge", "fox", "--stack"],
      (reporter) =>
        onTarget(box.home, { ref: "fox" }, (_, located) =>
          Effect.flatMap(landing, (service) =>
            service.merge({ located }, { stack: true }, reporter),
          ),
        ),
      repo,
      calls,
    );
  });

  it("cleans up a landed stack, and keeps the merge in the document when a teardown fails", async () => {
    const { repo, tree } = inProject(undefined, {
      scripts: { teardown: 'test "$SHIGOMORI_WORKTREE_NAME" != bad' },
    });
    tree("owl");
    tree("fox");
    tree("bad");
    const calls = scriptedGh([
      settingsRule({ merge: true }),
      {
        args: ["pr", "list", "--state", "all", "--head", "fox"],
        out: [pr(7, "fox", "owl", { state: "MERGED" })],
      },
      {
        args: ["pr", "list", "--state", "all", "--head", "bad"],
        out: [pr(9, "bad")],
      },
      {
        args: ["pr", "list", "--state", "all", "--limit"],
        out: [
          pr(7, "fox", "owl", { state: "MERGED" }),
          pr(6, "owl", "main", { state: "MERGED" }),
        ],
      },
      { args: ["pr", "merge", "9"], out: "" },
    ]);
    await sameLanding(
      ["worktrees", "rm", "fox", "--stack"],
      (reporter) =>
        onTarget(box.home, { ref: "fox" }, (_, located) =>
          Effect.flatMap(landing, (service) =>
            service.removeStack(
              located,
              { force: false, keepBranch: false, skipCleanup: false },
              reporter,
            ),
          ),
        ),
      repo,
      calls,
    );
    await landVerb(repo, "bad", calls);
  });

  it("lands a checkout back on the primary branch once its branch is merged", async () => {
    const { repo } = inProject();
    const calls = scriptedGh([
      {
        args: ["pr", "list", "--state", "merged", "--head", "unmerged"],
        out: [],
      },
    ]);
    box.git(repo, "checkout", "-q", "-b", "merged");
    box.git(repo, "checkout", "-q", "main");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "on main");
    box.git(repo, "checkout", "-q", "merged");
    const doneVerb = (flags: ReadonlyArray<string> = []) =>
      sameLanding(
        ["worktrees", "done", "repo/root", ...flags],
        () =>
          onTarget(box.home, { ref: "repo/root" }, (_, located) =>
            Effect.flatMap(landing, (service) =>
              service.done(located, { force: flags.includes("-f") }),
            ),
          ),
        repo,
        calls,
      );
    await doneVerb();
    box.git(repo, "checkout", "-q", "-b", "unmerged");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "unmerged work");
    await doneVerb();
    await doneVerb(["-f"]);
  });
});

describe("disk-usage", () => {
  const diskUsage = (root: string, exclude: ReadonlyArray<string> = []) =>
    same(
      ["disk-usage", root, ...exclude.flatMap((path) => ["--exclude", path])],
      Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
        hygiene.measure(root, exclude),
      ),
    );

  it("measures a tree: blocks once per inode, what removing it frees, and the newest real edit", async () => {
    const root = join(box.home, "tree");
    const old = new Date("2020-01-02T03:04:05Z");
    for (const [file, size] of [
      ["src/a.txt", 5000],
      ["src/deep/b.bin", 70_000],
      ["node_modules/pkg/index.js", 9000],
      ["nested/wt/big.bin", 200_000],
      ["dist/out.js", 300],
    ] as const) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "x".repeat(size));
      utimesSync(join(root, file), old, old);
    }
    // Newer, but only where nothing counts as activity.
    writeFileSync(join(root, "node_modules", "pkg", "fresh.js"), "new\n");
    // A link with its other name outside, one with both inside, a clone
    // and a symlink.
    const store = join(box.home, "store.bin");
    writeFileSync(store, "s".repeat(64 * 1024));
    linkSync(store, join(root, "src", "linked-out.bin"));
    writeFileSync(join(root, "src", "pair.bin"), "p".repeat(40_000));
    linkSync(join(root, "src", "pair.bin"), join(root, "src", "pair-2.bin"));
    execFileSync("cp", [
      "-c",
      join(root, "src/deep/b.bin"),
      join(root, "src/clone.bin"),
    ]);
    symlinkSync("a.txt", join(root, "src", "link"));
    await diskUsage(root);
    await diskUsage(root, [join(root, "nested", "wt")]);
    await diskUsage(join(box.home, "missing"));
    const usage = (await box.engine(
      Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
        hygiene.measure(root, []),
      ),
    )) as Hygiene.DiskUsage;
    // The link out of the tree and the clone hold blocks nothing frees.
    assert.ok(usage.reclaimableBytes > 0);
    assert.ok(usage.bytes - usage.reclaimableBytes >= 64 * 1024 + 70_000);
    const missing = (await box.engine(
      Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
        hygiene.measure(join(box.home, "missing"), []),
      ),
    )) as Hygiene.DiskUsage;
    assert.equal(missing.partial, true);
  });
});

// The tidy page's facts have no Go verb (the host computed them), so
// these hold the engine to the host's rules directly.
describe("hygiene facts", () => {
  it("tells merged, squash-merged, unique, detached and primary work apart", async () => {
    const { repo, tree } = seedProject({ "a.txt": "a\n" });
    const untouched = tree("untouched");
    writeFileSync(join(untouched, "scratch.txt"), "untracked\n");
    const squashed = tree("squashed");
    writeFileSync(join(squashed, "b.txt"), "b\n");
    box.git(squashed, "add", "b.txt");
    box.git(squashed, "commit", "-q", "-m", "b");
    // The squash merge: main takes the same change in a commit of its own.
    writeFileSync(join(repo, "b.txt"), "b\n");
    box.git(repo, "add", "b.txt");
    box.git(repo, "commit", "-q", "-m", "squash b");
    const unique = tree("unique");
    writeFileSync(join(unique, "c.txt"), "c\n");
    box.git(unique, "add", "c.txt");
    box.git(unique, "commit", "-q", "-m", "c");
    const detached = tree("detached");
    box.git(detached, "checkout", "-q", "--detach");

    const facts = (await box.engine(
      Effect.flatMap(Effect.service(Hygiene.Hygiene), (hygiene) =>
        hygiene.facts({ id: "P1", name: "repo", path: repo }),
      ),
    )) as ReadonlyArray<{
      worktreeId: string;
      uniqueCommits: number | null;
      contentAlreadyInPrimary: boolean;
      primaryRef: string | null;
      holdsPrimaryBranch: boolean;
      untracked: boolean;
    }>;
    const of = (path: string) => {
      const found = facts.find(
        (row) => row.worktreeId === worktreeIdFromPath(path),
      );
      assert.ok(found, path);
      const { worktreeId: _, ...rest } = found;
      return rest;
    };
    const primary = of(repo);
    assert.deepEqual(
      [
        primary.uniqueCommits,
        primary.contentAlreadyInPrimary,
        primary.primaryRef,
        primary.holdsPrimaryBranch,
      ],
      [null, false, "main", true],
    );
    assert.deepEqual(
      [of(untouched), of(squashed), of(unique), of(detached)].map(
        ({ uniqueCommits, contentAlreadyInPrimary, untracked }) => ({
          uniqueCommits,
          contentAlreadyInPrimary,
          untracked,
        }),
      ),
      [
        { uniqueCommits: 0, contentAlreadyInPrimary: true, untracked: true },
        { uniqueCommits: 1, contentAlreadyInPrimary: true, untracked: false },
        { uniqueCommits: 1, contentAlreadyInPrimary: false, untracked: false },
        {
          uniqueCommits: null,
          contentAlreadyInPrimary: false,
          untracked: false,
        },
      ],
    );
  });
});

describe("projects reorder", () => {
  it("moves the named projects to the front, keeping the rest in order, and lists that way", async () => {
    const [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map((name) =>
      box.repo(name),
    );
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
        { id: "G", name: "gamma", path: gamma },
      ],
      projectOrder: [beta, `${box.home}/elsewhere`, alpha],
    });
    const registry = Effect.service(Registry.Registry);
    const reorder = (ids: ReadonlyArray<string>) =>
      same(
        ["projects", "reorder", "--ids", ids.join(",")],
        registry.pipe(
          Effect.flatMap((service) =>
            Effect.flatMap(service.listed, (listed) =>
              service.reorder(listed, ids),
            ),
          ),
          Effect.as({ ok: true }),
        ),
      );
    const list = () =>
      same(
        ["projects", "list"],
        registry.pipe(Effect.flatMap((service) => service.rows())),
      );
    await inTurn([
      () => reorder(["G", "nope", "A"]),
      list,
      () => reorder(["G", "A"]),
      list,
    ]);
  });
});

const check = (
  updater: Updater.Updater["Service"],
  input: Updater.UpdateInput,
) => updater.check(input);

describe("update", () => {
  // The two feeds both sides ask, a local stand-in passed as Go's
  // --feed-url and --releases-url. Each case says what each path answers.
  type Served = {
    readonly status: number;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    // Bytes sent as they are, for the zip.
    readonly raw?: Uint8Array;
  };
  let served: Record<string, Served> = {};
  let server: Server;
  let base = "";

  beforeAll(async () => {
    goSmRelease("1.0.0");
    goSmRelease("2.0.0-beta.2");
    server = createServer((request, response) => {
      const answer = served[request.url ?? ""] ?? { status: 404 };
      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...answer.headers,
      });
      response.end(
        answer.raw ??
          (answer.body === undefined ? undefined : JSON.stringify(answer.body)),
      );
    });
    await new Promise<void>((listening) =>
      server.listen(0, "127.0.0.1", listening),
    );
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  }, 600_000);
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    served = {};
  });

  // The app installed in the sandbox, with `version`'s Go sm inside it
  // where a release puts the terminal command.
  const installed = (version: string) => {
    const binary = join(
      box.home,
      "Applications",
      "Shigoto no Mori.app",
      "Contents",
      "Resources",
      "sm",
    );
    mkdirSync(dirname(binary), { recursive: true });
    copyFileSync(goSmRelease(version), binary);
    return binary;
  };

  type Build = {
    readonly flavor: Flavor;
    readonly version: string;
    readonly binary: string;
  };

  // A mode run on each side: Go's documents (its events, then one result)
  // and the engine's events and answer, or its failure as the terminal
  // prints it.
  // A prerelease build asks the release list only without a feed
  // stand-in, so `feed` leaves that one out.
  const sameUpdate = async (
    build: Build,
    args: ReadonlyArray<string>,
    run: (
      updater: Updater.Updater["Service"],
      input: Updater.UpdateInput,
    ) => Effect.Effect<unknown, unknown>,
    feed = true,
  ) => {
    const flags = [
      ...(feed ? ["--feed-url", `${base}/feed`] : []),
      "--releases-url",
      `${base}/list`,
    ];
    const go = await box.runAt(build.binary, "go", box.home, [
      "--json",
      "update",
      ...args,
      ...flags,
    ]);
    const events: unknown[] = [];
    const input: Updater.UpdateInput = {
      progress: (step) =>
        Effect.sync(() => {
          if (step.phase === "downloading" || step.phase === "verifying") {
            events.push({ event: step.phase, version: step.version });
          }
        }),
      running: {
        version: build.version,
        arch: process.arch,
        executable: build.binary,
        pid: process.pid,
      },
      feedUrl: feed ? `${base}/feed` : undefined,
      releasesUrl: `${base}/list`,
    };
    const engine = await Effect.runPromise(
      Effect.flatMap(Updater.Updater, (updater) => run(updater, input)).pipe(
        Effect.match({
          onSuccess: (doc) => doc,
          onFailure: (error) => ({ ok: false, ...errorDocument(error) }),
        }),
        Effect.provide(
          Updater.layer(build.flavor).pipe(
            Layer.provideMerge(Paths.layer("prod")),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    HOME: box.home,
                    SHIGOMORI_DATA_DIR: box.side("engine"),
                  },
                }),
              ),
            ),
          ),
        ),
      ),
    );
    assert.deepStrictEqual([...events, engine], go.docs, go.stderr);
    return go.doc;
  };

  const release = (version: string): Build => ({
    flavor: "prod",
    version,
    binary: installed(version),
  });

  const feedAnswers = (version: string) => ({
    status: 200,
    body: {
      url: `${base}/zip`,
      name: `v${version}`,
      notes: `notes for ${version}`,
      pub_date: "Tue, 15 Sep 2026 12:00:00 -0700",
    },
  });

  it("refuses in a dev build", async () => {
    const dev: Build = { flavor: "dev", version: "dev", binary: goSm() };
    await sameUpdate(dev, ["--check"], (u, input) => u.check(input));
    await sameUpdate(dev, ["--stage"], (u, input) => u.stage(input));
    await sameUpdate(dev, [], (u, input) => u.update(input));
  });

  it("checks against the update server", async () => {
    const build = release("1.0.0");
    served["/feed"] = { status: 204 };
    await sameUpdate(build, ["--check"], check);
    served["/feed"] = feedAnswers("1.2.0");
    await sameUpdate(build, ["--check"], check);
    served["/feed"] = { status: 500 };
    await sameUpdate(build, ["--check"], check);
    served["/feed"] = { status: 200, body: { name: "v1.2.0" } };
    await sameUpdate(build, ["--check"], check);
  });

  it("stages nothing when up to date, and clears what a confirmed answer outdates", async () => {
    box.write("updates/staged/manifest.json", {
      version: "0.9.0",
      bundleName: "Shigoto no Mori.app",
    });
    box.write("updates/staged/Shigoto no Mori.app/Contents/info.json", {});
    const build = release("1.0.0");
    served["/feed"] = { status: 204 };
    assert.deepEqual(
      await sameUpdate(build, ["--stage"], (u, input) => u.stage(input)),
      { ok: true, status: "up-to-date", version: "1.0.0" },
    );
    for (const side of ["go", "engine"]) {
      assert.deepEqual(readdirSync(join(box.side(side), "updates")), [], side);
    }
    // The full update stops at the same answer.
    await sameUpdate(build, [], (u, input) => u.update(input));
  });

  it("answers with the bundle already staged for the release", async () => {
    box.write("updates/staged/manifest.json", {
      version: "1.2.0",
      bundleName: "Shigoto no Mori.app",
      notes: "notes for 1.2.0",
      releaseDate: "2026-09-15T19:00:00Z",
    });
    box.write("updates/staged/Shigoto no Mori.app/Contents/info.json", {});
    served["/feed"] = feedAnswers("1.2.0");
    assert.deepEqual(
      await sameUpdate(release("1.0.0"), ["--stage"], (u, input) =>
        u.stage(input),
      ),
      {
        ok: true,
        status: "staged",
        version: "1.2.0",
        installed: "1.0.0",
        notes: "notes for 1.2.0",
        releaseDate: "2026-09-15T19:00:00Z",
      },
    );
  });

  it("stages from a feed that dates its release in RFC 1123, and refuses an installed app with no Team ID", async () => {
    // Staging only succeeds under a Developer ID signature, so both sides
    // run the download, extraction and verification, and refuse at the
    // unsigned installed app.
    const dir = join(box.home, "release");
    const bundle = join(dir, "Shigoto no Mori.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(bundle, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>x</string><key>CFBundleIdentifier</key><string>test.shigomori</string></dict></plist>\n',
    );
    writeFileSync(join(bundle, "Contents", "MacOS", "x"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    execFileSync("/usr/bin/codesign", ["-s", "-", "--deep", bundle]);
    execFileSync("/usr/bin/ditto", ["-c", "-k", dir, `${dir}.zip`]);
    served["/feed"] = feedAnswers("1.2.0");
    served["/zip"] = { status: 200, raw: readFileSync(`${dir}.zip`) };
    const doc = await sameUpdate(release("1.0.0"), ["--stage"], (u, input) =>
      u.stage(input),
    );
    assert.match(
      (doc as { error: string }).error,
      /^Couldn't read the code signature of .*Shigoto no Mori\.app: /,
    );
  });

  it("refuses outside an app bundle, and while another update runs", async () => {
    served["/feed"] = { status: 204 };
    const stray: Build = {
      flavor: "prod",
      version: "1.0.0",
      binary: goSmRelease("1.0.0"),
    };
    await sameUpdate(stray, ["--stage"], (u, input) => u.stage(input));
    // The sides exist by now, so each gets the lock in its own data dir.
    for (const side of ["go", "engine"]) {
      mkdirSync(join(box.side(side), "updates"), { recursive: true });
      writeFileSync(
        join(box.side(side), "updates", "staging.pid"),
        `${process.pid}\n`,
      );
    }
    const doc = await sameUpdate(release("1.0.0"), ["--stage"], (u, input) =>
      u.stage(input),
    );
    assert.deepEqual(doc, {
      ok: false,
      error: `Another update is already in progress (pid ${process.pid}).`,
      code: "update-in-progress",
    });
  });

  it("follows a prerelease channel through the release list", async () => {
    const build = release("2.0.0-beta.2");
    const asset = (tag: string) => ({
      tag_name: tag,
      prerelease: true,
      body: `notes for ${tag}`,
      published_at: "2026-09-15T12:00:00Z",
      assets: [
        {
          name: `Shigoto.no.Mori-darwin-${process.arch}-${tag.slice(1)}.zip`,
          browser_download_url: `${base}/zip`,
        },
      ],
    });
    // GitHub's budget spent, and no copy to answer from.
    const reset = Math.floor(Date.now() / 1000) + 30 * 60;
    served["/list"] = {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
    };
    await sameUpdate(build, ["--check"], check, false);
    served["/list"] = {
      status: 200,
      body: [asset("v2.0.0-beta.3"), asset("v2.1.0-beta.1")],
    };
    await sameUpdate(build, ["--check"], check, false);
    // Each side then answers from the copy the other one kept.
    served["/list"] = { status: 500 };
    const kept = (side: string) =>
      join(box.side(side), "updates", "release-list.json");
    const fromGo = readFileSync(kept("go"));
    copyFileSync(kept("engine"), kept("go"));
    writeFileSync(kept("engine"), fromGo);
    assert.equal(
      (
        (await sameUpdate(build, ["--check"], check, false)) as {
          version: string;
        }
      ).version,
      "2.0.0-beta.3",
    );
  });
});

// Each finding as "<id>:<status>".
const ids = (doc: Doctor.DoctorDocument) =>
  doc.checks.map(({ id, status }) => `${id}:${status}`);

describe("doctor", () => {
  // The one thing that differs between the sides: each has its own data
  // dir, whose path the document and its lines name.
  const sideNeutral = (doc: unknown): unknown => {
    if (typeof doc === "string") {
      return ["go", "engine"].reduce(
        (text, side) =>
          text
            .replaceAll(`${box.home}/${side}`, "<data>")
            .replace(new RegExp(`~/${side}(?![\\w-])`, "g"), "<data>"),
        doc,
      );
    }
    if (Array.isArray(doc)) return doc.map(sideNeutral);
    if (typeof doc === "object" && doc !== null) {
      return Object.fromEntries(
        Object.entries(doc).map(([key, value]) => [key, sideNeutral(value)]),
      );
    }
    return doc;
  };

  // `sm doctor --json`, and with `fix` its `--fix --yes`, on each side
  // against the same repos. The version is the Go build's own, "dev".
  const sameDoctor = async (fix = false) => {
    const [go, engine] = await box.changeBoth(
      () => box.go("doctor", ...(fix ? ["--fix", "--yes"] : [])),
      () =>
        box.engine(
          Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
            doctor.run({
              version: "dev",
              executable: "",
              terminal: false,
              ...(fix ? { fix: { approve: () => Effect.succeed(true) } } : {}),
            }),
          ),
        ),
    );
    assert.deepStrictEqual(sideNeutral(engine), sideNeutral(go));
    return go as Doctor.DoctorDocument;
  };

  // A gh that is signed in, so the line reads the same on any machine.
  beforeEach(() => {
    box.fakeBin(
      "gh",
      'case "$1" in auth) exit 0;; --version) echo "gh version 9.9.9 (2026-01-01)";; esac',
    );
  });

  // Backdates a file the seed holds, past any staleness window.
  const backdate = (file: string) => {
    const old = new Date("2020-01-02T03:04:05Z");
    utimesSync(join(box.home, "seed", file), old, old);
  };

  it("reports a healthy project, then deletes the stale locks", async () => {
    inProject();
    box.write("state.json.lock", 1);
    box.write("iconCache/index.json.lock", 1);
    box.write("projects/P1/project.json.lock", 1);
    box.write("updates/old.lock", 1);
    for (const lock of [
      "state.json.lock",
      "iconCache/index.json.lock",
      "projects/P1/project.json.lock",
      "updates/old.lock",
    ]) {
      backdate(lock);
    }
    box.write("fresh.lock", 1);
    const before = await sameDoctor();
    assert.ok(ids(before).includes("locks:warn"));
    assert.ok(ids(before).includes("project:ok"));
    const after = await sameDoctor(true);
    assert.deepEqual(after.repaired, ["deleted 3 stale lock files"]);
    assert.ok(ids(after).includes("locks:ok"));
  });

  it("unregisters a project whose repo is gone, and keeps the one that's there", async () => {
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [
        { id: "P1", name: "repo", path: repo },
        { id: "P2", name: "ghost", path: join(box.home, "ghost") },
      ],
    });
    box.write("projects/P1/project.json", { defaultBranch: "main" });
    box.write("projects/P2/project.json", { defaultBranch: "main" });
    const before = await sameDoctor();
    assert.ok(ids(before).includes("project-path:fail"));
    const after = await sameDoctor(true);
    assert.deepEqual(after.repaired, ["unregistered ghost"]);
  });

  it("re-links a moved worktree, prunes one that's gone, and leaves a stray and a locked one", async () => {
    const { repo, tree } = inProject();
    const base = join(repo, ".shigomori", "worktrees");
    const outside = join(box.home, "elsewhere", "feat");
    box.git(repo, "worktree", "add", "-q", "-b", "feat", outside);
    const gone = tree("gone");
    const locked = tree("locked");
    box.git(repo, "worktree", "lock", locked);
    box.write("registry.json", {
      projects: [{ id: "P1", name: "repo", path: repo }],
      shelvedWorktrees: { [worktreeIdFromPath(outside)]: true },
      autoPullWorktrees: {
        [worktreeIdFromPath(gone)]: true,
        deadbeef1234: true,
      },
    });
    box.write(`projects/P1/worktrees/${worktreeIdFromPath(gone)}.json`, {
      title: "gone",
    });
    renameSync(outside, join(base, "feat"));
    rmSync(gone, { recursive: true });
    rmSync(locked, { recursive: true });
    mkdirSync(join(base, "stray"));
    const before = await sameDoctor();
    assert.ok(ids(before).includes("project-moved:warn"));
    assert.ok(ids(before).includes("project-worktrees:warn"));
    assert.ok(ids(before).includes("project-strays:warn"));
    const after = await sameDoctor(true);
    assert.deepEqual(after.repaired, [
      "re-linked 1 moved worktree for repo",
      "pruned git's worktree metadata for repo",
    ]);
    assert.ok(ids(after).includes("project-strays:warn"));
  });

  it("names launchers, carry-over, scripts and an include that point at nothing", async () => {
    const { repo } = inProject(
      { "a.txt": "a\n", "scripts/present.sh": "true\n" },
      {
        defaultBranch: "release/never-existed",
        carryOver: [
          { path: ".env", mode: "copy" },
          { path: ".env.local", mode: "copy" },
          { path: "my file", mode: "copy" },
        ],
        launchers: [
          { id: "c", label: "My Tool", command: "/no/such/binary ." },
          { id: "d", label: "shell", command: "sh -c true" },
        ],
        scripts: {
          setup: "bash scripts/present.sh && bash ./scripts/absent.sh --ci",
          teardown: "curl https://example.com/x.sh | sh",
        },
      },
    );
    writeFileSync(join(repo, ".env"), "X=1\n");
    mkdirSync(join(repo, ".worktreeinclude"));
    const empty = join(box.home, "empty");
    mkdirSync(empty);
    box.git(empty, "init", "-q", "-b", "main");
    box.write("registry.json", {
      projects: [
        { id: "P1", name: "repo", path: repo },
        { id: "E1", name: "empty", path: empty },
      ],
    });
    box.fakeBin(
      "port-pool",
      `echo "  3038 -> ${repo} (8/15/2026)"; echo "  4000 -> ${box.home}/gone (8/15/2026)"`,
    );
    box.write("config.json", {
      portPool: true,
      launchers: [
        { id: "a", label: "Ghost", command: "no-such-program-9f3a --flag" },
        { id: "b", label: "env", command: "$EDITOR ." },
      ],
    });
    const doc = await sameDoctor();
    for (const id of [
      "launchers:warn",
      "project-carryover:warn",
      "project-launchers:warn",
      "project-scripts:warn",
      "project-include:warn",
      "project-branch:warn",
      "ports:warn",
    ]) {
      assert.ok(ids(doc).includes(id), id);
    }
  });

  it("finds what a crash left: update files, a staging lock, landing refs and a running script", async () => {
    const { repo } = inProject();
    box.write("updates/staging.pid", 999999);
    mkdirSync(join(box.home, "seed", "updates", "extract"), {
      recursive: true,
    });
    writeFileSync(
      join(box.home, "seed", "updates", "download.zip"),
      "x".repeat(2048),
    );
    writeFileSync(join(box.home, "seed", "updates", "extract", "a"), "x");
    box.git(repo, "update-ref", "refs/shigomori/incoming/fresh", "HEAD");
    box.git(repo, "update-ref", "refs/shigomori/incoming/feat", "HEAD");
    box.git(repo, "update-ref", "refs/shigomori/incoming/packed", "HEAD");
    box.git(repo, "pack-refs", "--include", "refs/shigomori/incoming/packed");
    const old = new Date("2020-01-02T03:04:05Z");
    utimesSync(
      join(repo, ".git", "refs", "shigomori", "incoming", "feat"),
      old,
      old,
    );
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      box.write("running-scripts.json", {
        ownerPid: 999999,
        scripts: [
          { pid: sleeper.pid, startedAt: Date.now(), command: "pnpm dev" },
        ],
      });
      const before = await sameDoctor();
      for (const id of [
        "staging-lock:warn",
        "update-leftovers:warn",
        "scripts:warn",
        "project-incoming:warn",
      ]) {
        assert.ok(ids(before).includes(id), id);
      }
      const after = await sameDoctor(true);
      assert.deepEqual(after.repaired, [
        "deleted the stale update staging lock",
        "deleted 2 KB of leftover update files",
        "deleted 2 leftover landing refs in repo",
      ]);
    } finally {
      sleeper.kill();
    }
  });
});
