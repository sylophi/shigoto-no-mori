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

// The same command through both binaries from `cwd`, each on its own
// copy. Under --json the documents are compared, not their bytes (Go
// sorts keys and escapes <, > and &); a person's output is compared as
// text.
const sameAt = async (cwd: string, ...args: string[]) => {
  const [go, ours] = await Promise.all([
    box.runAt(goSm(), "go", cwd, args),
    box.runAt(built, "cli", cwd, args),
  ]);
  const seen = (run: typeof go) =>
    args.includes("--json")
      ? {
          code: run.code,
          doc: withoutHue(withoutFileMarker(run.doc)),
          stderr: run.stderr,
        }
      : { code: run.code, stdout: run.stdout, stderr: run.stderr };
  assert.deepStrictEqual(seen(ours), seen(go), args.join(" "));
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
