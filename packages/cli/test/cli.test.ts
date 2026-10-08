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

// The same command through both binaries, each on its own copy. Under
// --json the documents are compared, not their bytes (Go sorts keys and
// escapes <, > and &); a person's output is compared as text.
const same = async (...args: string[]) => {
  const [go, ours] = await Promise.all([
    box.runAt(goSm(), "go", box.home, args),
    box.runAt(built, "cli", box.home, args),
  ]);
  const seen = (run: typeof go) =>
    args.includes("--json")
      ? { code: run.code, doc: withoutFileMarker(run.doc), stderr: run.stderr }
      : { code: run.code, stdout: run.stdout, stderr: run.stderr };
  assert.deepStrictEqual(seen(ours), seen(go));
};

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
