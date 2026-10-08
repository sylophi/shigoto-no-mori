import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Registry from "../src/Registry.ts";
import * as Terrier from "../src/Terrier.ts";
import { terrierProjects } from "../src/Terrier.ts";
import { terrierProjectId } from "../src/terrierId.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

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
  box.fakeBin(
    "terrier",
    `if [ "$1" = version ]; then echo v0.1.0; else echo '{"projects":[{"path":"${repo}"}]}'; fi`,
  );
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

it("says terrier isn't on PATH only when there is none to run", async () => {
  box.write("config.json", { terrier: true });
  process.env.PATH = "/nonexistent";
  const listing = (await box.engine(
    Effect.flatMap(
      Effect.service(Terrier.Terrier),
      (terrier) => terrier.listing,
    ),
  )) as Terrier.TerrierListing;
  assert.match(
    Option.getOrThrow(listing.trouble).summary,
    /`terrier` isn't on PATH/,
  );
});
