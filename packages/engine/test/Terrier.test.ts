import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Registry from "../src/Registry.ts";
import { terrierProjects } from "../src/Terrier.ts";
import { terrierProjectId } from "../src/terrierId.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
const originalPath = process.env.PATH;
beforeEach(() => {
  box = sandbox();
});
afterEach(async () => {
  process.env.PATH = originalPath;
  await box.remove();
});

it("mints the Go sm's id for a path", () => {
  assert.equal(
    terrierProjectId("/tmp/repo"),
    "B6FE87A9-B936-BEA6-5048-1980F473639B",
  );
});

it("adds the paths the registry lacks, by name then path", () => {
  assert.deepEqual(
    terrierProjects(new Set(["/r/b"]), [
      "/x/b",
      "/r/b",
      "/a/b",
      "/r/a",
      "/x/b",
      "",
    ]).map(({ path }) => path),
    ["/r/a", "/a/b", "/x/b"],
  );
});

it("registers a terrier repo under its terrier id, and hands its settings back on removal", async () => {
  const repo = box.repo("repo");
  const bin = join(box.home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "terrier"),
    `#!/bin/sh\nif [ "$1" = version ]; then echo v0.1.0; else echo '{"projects":[{"path":"${repo}"}]}'; fi\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  box.write("config.json", { terrier: true });
  const id = terrierProjectId(repo);
  const result = await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const config = yield* Config.Config;
      const added = yield* registry.register({ name: "repo", path: repo });
      yield* config.set(
        { kind: "project", projectId: added.id, path: repo },
        "defaultBranch",
        "trunk",
      );
      yield* registry.unregister(added.id);
      const listed = yield* registry.listed;
      const kept = yield* config.get(
        { kind: "project", projectId: id, path: repo },
        "defaultBranch",
      );
      return [added.id, listed, kept.value];
    }),
  );
  assert.deepEqual(result, [
    id,
    [{ id, name: "repo", path: repo, source: "terrier" }],
    "trunk",
  ]);
});
