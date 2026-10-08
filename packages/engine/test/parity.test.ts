// The parity harness: each verb the engine can answer, run as the Go
// `sm --json` and as the engine's service call against copies of one
// sandbox, and the two documents compared. The CLI's surface is frozen
// (V3.md, decision 13), so a difference here is a bug in the engine,
// whatever the engine's own tests say. A case reads as the terminal
// command will: the service's answer wrapped the way the verb prints it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  onTestFinished,
} from "vitest";
import * as Config from "../src/Config.ts";
import * as Icons from "../src/Icons.ts";
import * as Launchers from "../src/Launchers.ts";
import * as Registry from "../src/Registry.ts";
import * as Scripts from "../src/Scripts.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import * as Worktrees from "../src/Worktrees.ts";
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
  ) => Effect.Effect<A, E>,
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
const fakeGh = (answer: { prs?: unknown[]; stderr?: string }) => {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const script = join(bin, "gh");
  writeFileSync(
    script,
    answer.stderr === undefined
      ? `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(answer.prs ?? [])}\nJSON\n`
      : `#!/bin/sh\necho ${JSON.stringify(answer.stderr)} >&2\nexit 1\n`,
  );
  chmodSync(script, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  onTestFinished(() => {
    process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  });
};

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
                .pipe(Effect.map((worktree) => ({ ok: true, worktree }))),
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
