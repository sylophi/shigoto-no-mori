// The terminal binary, built as it ships, against the Go sm on copies
// of one sandbox: each verb's exit code, JSON document, output and
// errors. Under --json the documents must match (the CLI's surface is
// frozen, V3.md decision 13); a person's output too, where it's ours.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "vitest";
import { goSm, type Sandbox, sandbox } from "../../engine/test/lib/sandbox.ts";

let built: string;
let buildDir: string;
beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "sm-cli-"));
  built = join(buildDir, "smd");
  execFileSync(process.execPath, ["build.mts", built], {
    cwd: join(import.meta.dirname, ".."),
    stdio: "ignore",
  });
  goSm();
}, 300_000);
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// `config read` prints the file as stored, with the marker the JSON
// files carry and the store has no use for.
const withoutFileMarker = (doc: unknown) => {
  const { config, ...rest } = (doc ?? {}) as { config?: unknown };
  if (typeof config !== "object" || config === null) return doc;
  const { schemaVersion: _, ...stored } = config as Record<string, unknown>;
  return { ...rest, config: stored };
};

// A project row's hue, which the engine leaves null (V3.md, decision 12).
const withoutHue = (doc: unknown) =>
  Array.isArray(doc)
    ? doc.map((row: unknown) => Object.assign({}, row, { hue: null }))
    : doc;

// What differs by side: a new project's id, random on each, and the
// side's own data dir, where managed worktrees go. Only the run's own
// dir is masked, so one side using the other's still shows.
const withoutSideDetails = (seen: object, side: string) =>
  JSON.parse(
    JSON.stringify(seen)
      .replaceAll(`${box.home}/${side}/`, "<data>/")
      .replaceAll(
        /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g,
        "<id>",
      ),
  ) as unknown;

// The same command through both binaries from `cwd`, each on its own
// copy. Under --json the documents are compared, not their bytes (Go
// sorts keys and escapes <, > and &); a person's output is compared as
// text.
const sameAt = async (cwd: string, ...args: string[]) => {
  const [go, ours] = await Promise.all([
    box.runAt(goSm(), "go", cwd, args),
    box.runAt(built, "cli", cwd, args),
  ]);
  const seen = (run: typeof go, side: string) =>
    withoutSideDetails(
      args.includes("--json")
        ? {
            code: run.code,
            doc: withoutHue(withoutFileMarker(run.doc)),
            stderr: run.stderr,
          }
        : { code: run.code, stdout: run.stdout, stderr: run.stderr },
      side,
    );
  assert.deepStrictEqual(seen(ours, "cli"), seen(go, "go"), args.join(" "));
};

const same = (...args: string[]) => sameAt(box.home, ...args);

describe("config", () => {
  it("lists, gets and reads a fresh install's settings", async () => {
    await same("--json", "config", "list");
    await same("config", "list");
    await same("config", "get", "doubutsuNames");
    await same("--json", "config", "get", "launchers");
    await same("--json", "config", "read");
    await same("config", "read");
  });

  it("refuses what Go refuses, with its words and exit codes", async () => {
    box.write("registry.json", { projects: [] });
    await same("config", "get", "nope");
    await same("--json", "config", "get", "theme");
    await same("config", "set", "autoPullNew", "maybe");
    await same("--json", "config", "set", "launchers", "x");
    await same("config", "set", "hiddenLaunchers", "x");
    await same(
      "--json",
      "config",
      "write",
      "--data",
      '{"launchScripts":"yes"}',
    );
  });

  // The parser's words are effect/cli's, so only the outcome is Go's.
  it("exits 2 on a command used wrongly, and 0 on help", async () => {
    const misuses = [
      ["--json", "config", "get"],
      ["--json", "config", "bogus"],
      ["--json", "config", "set", "--foo", "x", "y"],
    ];
    const runs = await Promise.all(
      misuses.map((args) => box.runAt(built, "cli", box.home, args)),
    );
    for (const run of runs) {
      assert.equal(run.code, 2, run.stdout);
      assert.equal((run.doc as { ok?: unknown }).ok, false, run.stdout);
    }
    const help = await box.runAt(built, "cli", box.home, ["--help"]);
    assert.equal(help.code, 0);
  });

  it("sets, unsets and writes, then reads back the same", async () => {
    box.write("config.json", { portPool: true, fromNewerBuild: 1 });
    box.write("registry.json", { projects: [] });
    await same("config", "set", "terrier", "on");
    await same("--json", "config", "set", "deleteBranchOnRemove", "no");
    await same("config", "unset", "portPool");
    await same(
      "--json",
      "config",
      "write",
      "--data",
      '{"launchScripts":false,"launchers":[{"id":"a","label":"A","command":"a"}]}',
    );
    await same("--json", "config", "list");
  });
});

describe("projects", () => {
  // Two projects and one whose folder is gone, in a manual order.
  const projects = () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const alpha = box.repo("alpha", { "public/favicon.svg": svg });
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
        { id: "G", name: "gone", path: `${box.home}/gone` },
      ],
      projectOrder: [beta, alpha],
    });
    return { alpha, beta };
  };

  it("says when there are none", async () => {
    await same("projects", "list");
    await same("--json", "projects", "list");
  });

  it("lists the projects in their order", async () => {
    projects();
    await same("projects", "list");
    await same("projects", "ls");
    await same("p", "list", "--refresh-icons", "--json");
  });

  it("lists terrier's projects beside the registry's", async () => {
    projects();
    box.fakeBin(
      "terrier",
      `if [ "$1" = version ]; then echo v0.1.4; else echo '${JSON.stringify({
        projects: [{ path: box.repo("zeta") }],
      })}'; fi`,
    );
    box.write("config.json", { terrier: true });
    await same("projects", "list");
    await same("--json", "projects", "list");
  });

  it("warns when terrier can't be read", async () => {
    projects();
    box.fakeBin("terrier", "echo v0.2.0");
    box.write("config.json", { terrier: true });
    await same("projects", "list");
    await same("--json", "projects", "list");
  });

  it("prints a project's icon, named or at the cwd", async () => {
    const { alpha, beta } = projects();
    await same("--json", "projects", "icon", "alpha");
    await same("projects", "icon", "-p", "alpha");
    await same("--json", "projects", "icon", "--project-id", "B");
    await same("projects", "icon", "beta");
    await same("projects", "icon", "alpha", "-p", "");
    await sameAt(alpha, "--json", "projects", "icon");
    await sameAt(beta, "projects", "icon");
  });

  it("refuses a project it can't name, as Go does", async () => {
    projects();
    await same("projects", "icon", "nope");
    await same("--json", "projects", "icon", "--project-id", "nope");
    await same("--json", "projects", "icon");
    await same("projects", "config", "list", "-p", `${box.home}/elsewhere`);
  });

  it("lists, gets, sets and unsets a project's settings", async () => {
    const { alpha } = projects();
    await same("--json", "projects", "config", "list", "-p", "alpha");
    await same("projects", "config", "-p", "alpha", "list");
    await sameAt(alpha, "--json", "projects", "config", "read");
    await same("projects", "config", "set", "portBase", "4000", "-p", "beta");
    await sameAt(alpha, "projects", "config", "set", "scripts.setup", "pnpm i");
    await same(
      "--json",
      "projects",
      "config",
      "get",
      "scripts.setup",
      "-p",
      "alpha",
    );
    await same("projects", "config", "unset", "scripts.setup", "-p", "alpha");
    await same(
      "projects",
      "config",
      "set",
      "scripts.teardown",
      "",
      "-p",
      "alpha",
    );
    await same(
      "--json",
      "projects",
      "config",
      "set",
      "worktreeLayout",
      "sideways",
      "-p",
      "alpha",
    );
    await same("projects", "config", "set", "carryOver", "x", "-p", "alpha");
    await same("--json", "projects", "config", "read", "-p", "beta");
  });
});

describe("projects add, remove and reorder", () => {
  it("adds the repo a folder is in, at its primary checkout", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta", {
      "package.json": "{}",
      "pnpm-lock.yaml": "",
      "src/index.ts": "",
    });
    box.write("registry.json", { projects: [] });
    box.write("config.json", {
      autoPullNew: true,
      autoPopulateInstall: true,
    });
    await sameAt(alpha, "projects", "add");
    await same("--json", "projects", "add", `${beta}/src`);
    await same("--json", "projects", "config", "read", "-p", "beta");
    await same("--json", "projects", "config", "read", "-p", "alpha");
    await same("projects", "add", "beta");
    await same("--json", "projects", "add", "alpha");
    await same("projects", "add", box.home);
    await same("--json", "projects", "list");
  });

  it("adds every repo under a folder once told yes", async () => {
    box.repo("one");
    box.repo("two");
    box.repo(".hidden");
    box.repo("node_modules");
    const known = box.repo("known");
    box.write("registry.json", {
      projects: [{ id: "K", name: "known", path: known }],
    });
    await same("projects", "add", "--all", box.home);
    await same("--json", "projects", "add", "-a", "-y", box.home);
    await same("projects", "add", "--all", "--yes", box.home);
    await same("--json", "projects", "add", "--all", `${box.home}/nowhere`);
  });

  it("removes a project once told yes, and leaves terrier's", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.git(alpha, "worktree", "add", "-q", "-b", "w", `${box.home}/w`);
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    box.fakeBin(
      "terrier",
      `if [ "$1" = version ]; then echo v0.1.4; else echo '${JSON.stringify({
        projects: [{ path: box.repo("zeta") }],
      })}'; fi`,
    );
    box.write("config.json", { terrier: true });
    await same("projects", "remove", "alpha");
    await same("--json", "projects", "remove");
    await same("projects", "remove", "zeta", "--yes");
    await same("--json", "projects", "rm", "--project-id", "B", "-y");
    await same("projects", "remove", "alpha", "-y");
    await same("--json", "projects", "remove", "--project-id", "B", "-y");
    await same("--json", "projects", "list");
  });

  it("reorders the projects by id", async () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    await same("projects", "reorder");
    await same("--json", "projects", "reorder", "--ids", "B, nope,A");
    await same("projects", "list");
    await same("projects", "reorder", "--ids", "A");
    await same("--json", "projects", "list");
  });
});

describe("worktrees", () => {
  // Two projects: one with a linked worktree and a title on it, one
  // with only its primary.
  const projects = () => {
    const alpha = box.repo("alpha");
    const beta = box.repo("beta");
    box.git(alpha, "worktree", "add", "-q", "-b", "fox", `${box.home}/fox`);
    box.write("registry.json", {
      projects: [
        { id: "A", name: "alpha", path: alpha },
        { id: "B", name: "beta", path: beta },
      ],
    });
    box.write("projects/A/project.json", { defaultBranch: "main" });
    return { alpha, beta, fox: `${box.home}/fox` };
  };

  it("lists the worktrees, scoped to the project at the cwd", async () => {
    const { alpha, fox } = projects();
    await same("list");
    await same("--json", "list");
    await sameAt(fox, "ls");
    await sameAt(fox, "--json", "wt", "l", "--all");
    await same("w", "list", "-p", "alpha");
    await same("--json", "worktrees", "list", "--project-id", "B");
    await sameAt(alpha, "list", "--identities");
    await same("--json", "list", "--identities", "--primary-ref");
    await same("list", "--primary-ref");
  });

  it("names one worktree by id, as the app does", async () => {
    const { fox } = projects();
    const id = (
      (await box.runAt(goSm(), "go", fox, ["--json", "path"])).doc as {
        id: string;
      }
    ).id;
    await same("--json", "list", "--worktree-id", id);
    await same("list", "--worktree-id", id, "--identities");
    await sameAt(fox, "list", "--worktree-id", id, "--identities");
    await same("--json", "list", "--worktree-id", "nope");
  });

  it("prints a worktree's folder however it's named", async () => {
    const { alpha, fox } = projects();
    await same("path", "fox");
    await same("--json", "path", "alpha/fox");
    await sameAt(fox, "path");
    await sameAt(alpha, "--json", "path", "root");
    await same("path", "fox", "-p", "beta");
    await same("--json", "path", "nope");
    await same("path");
    await same("path", "fox", "extra");
    await same("list", "alpha");
    await same("projects", "ls");
    await same("--json", "p", "rm", "--project-id", "B", "--yes");
  });

  it("says where a new worktree would go", async () => {
    projects();
    await same("--json", "destination", "-p", "alpha", "--name", "owl");
    await same("worktrees", "destination", "-p", "alpha", "--name", "FOX");
    await same("--json", "destination", "-p", "alpha", "--name", "primary");
    await same("destination", "-p", "alpha", "--name", "a/b");
    await same("destination", "-p", "alpha", "extra");
  });

  it("says when there are no projects", async () => {
    await same("list");
    await same("--json", "list", "--identities");
  });
});

describe("doctor", () => {
  // Each side's data dir, which the checklist names, as one.
  const sideNeutral = (seen: unknown): unknown =>
    JSON.parse(
      ["go", "cli"].reduce(
        (text, side) =>
          text
            .replaceAll(`${box.home}/${side}`, "<data>")
            .replaceAll(`~/${side}`, "<data>"),
        JSON.stringify(seen),
      ),
    ) as unknown;
  const sameDoctor = async (...args: string[]) => {
    const [go, ours] = await Promise.all([
      box.runAt(goSm(), "go", box.home, args),
      box.runAt(built, "cli", box.home, args),
    ]);
    const seen = (run: typeof go) =>
      sideNeutral(
        args.includes("--json")
          ? { code: run.code, doc: run.doc, stderr: run.stderr }
          : { code: run.code, stdout: run.stdout, stderr: run.stderr },
      );
    assert.deepStrictEqual(seen(ours), seen(go), args.join(" "));
  };

  // A gh that is signed in, so its line reads the same on any machine.
  beforeEach(() => {
    box.fakeBin(
      "gh",
      'case "$1" in auth) exit 0;; --version) echo "gh version 9.9.9 (2026-01-01)";; esac',
    );
  });

  // A project that is there and one whose repo is gone.
  beforeEach(() => {
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [
        { id: "P1", name: "repo", path: repo },
        { id: "P2", name: "ghost", path: `${box.home}/ghost` },
      ],
    });
    box.write("projects/P1/project.json", { defaultBranch: "main" });
    box.write("projects/P2/project.json", { defaultBranch: "main" });
  });

  it("checks the install, and refuses a command line it can't use", async () => {
    await sameDoctor("doctor");
    await sameDoctor("--json", "doctor");
    await sameDoctor("doctor", "--yes");
    await sameDoctor("--json", "doctor", "extra");
  });

  it("repairs what it can, asking before a deletion", async () => {
    await sameDoctor("doctor", "--fix");
    await sameDoctor("--json", "doctor", "--fix", "--yes");
    await sameDoctor("doctor");
  });
});

describe("launchers", () => {
  it("lists a project's row and the catalog", async () => {
    const repo = box.repo("repo");
    box.write("registry.json", {
      projects: [{ id: "R", name: "repo", path: repo }],
    });
    box.write("config.json", {
      launchers: [{ id: "c1", label: "Shell", command: "zsh" }],
      hiddenLaunchers: ["app:finder"],
    });
    await same("--json", "launchers", "-p", "repo");
    await same("launchers", "list", "-p", "repo");
    await sameAt(repo, "launchers");
    await same("--json", "launchers", "--catalog");
    await same("launchers", "--catalog");
    await same("launchers", "bogus", "-p", "repo");
  });
});
