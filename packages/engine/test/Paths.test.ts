import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, it } from "vitest";
import * as Paths from "../src/Paths.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "engine-paths-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const resolve = (env: Record<string, string> = {}) =>
  Effect.service(Paths.Paths).pipe(
    Effect.provide(
      Paths.layer("prod").pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { HOME: home, ...env } }),
          ),
        ),
      ),
    ),
    Effect.runPromise,
  );

const pointTo = (target: string, name = "data-dir") => {
  mkdirSync(join(home, ".config", "shigomori"), { recursive: true });
  writeFileSync(join(home, ".config", "shigomori", name), `${target}\n`);
};

it("defaults to the flavor's folder in the home directory", async () => {
  const paths = await resolve();
  assert.equal(paths.dataDir, join(home, ".sm"));
  assert.equal(paths.dataDirSource, "default");
  assert.equal(paths.store, join(home, ".sm", "store.db"));
});

it("takes SHIGOMORI_DATA_DIR over everything, home-expanded", async () => {
  pointTo(join(home, "elsewhere"));
  const paths = await resolve({ SHIGOMORI_DATA_DIR: "~/sandbox" });
  assert.equal(paths.dataDir, join(home, "sandbox"));
  assert.equal(paths.dataDirSource, "env");
});

it("refuses the retired SHIGOMORI_ROOT", async () => {
  await assert.rejects(resolve({ SHIGOMORI_ROOT: "/x" }), /SHIGOMORI_ROOT/);
});

it("follows a pointer to an empty, missing or used directory", async () => {
  pointTo("~/moved");
  assert.equal((await resolve()).dataDir, join(home, "moved"));
  mkdirSync(join(home, "used"));
  writeFileSync(join(home, "used", "registry.json"), "{}");
  pointTo(join(home, "used"));
  assert.deepEqual(
    [(await resolve()).dataDir, (await resolve()).dataDirSource],
    [join(home, "used"), "pointer"],
  );
});

it("passes over a pointer at a folder of someone else's files", async () => {
  mkdirSync(join(home, "Documents"));
  writeFileSync(join(home, "Documents", "notes.txt"), "");
  pointTo(join(home, "Documents"));
  assert.equal((await resolve()).dataDirSource, "default");
});

it("reads the pre-2.0 pointer only when the current one is absent", async () => {
  pointTo(join(home, "old"), "root");
  assert.equal((await resolve()).dataDir, join(home, "old"));
  pointTo("relative/path");
  assert.equal((await resolve()).dataDirSource, "default");
});

it("adopts a pre-2.0 data dir that holds state while the current is empty", async () => {
  mkdirSync(join(home, "shigomori"));
  writeFileSync(join(home, "shigomori", "state.json"), "{}");
  assert.equal((await resolve()).dataDirSource, "legacy");
  mkdirSync(join(home, ".sm"));
  writeFileSync(join(home, ".sm", "store.db"), "");
  assert.equal((await resolve()).dataDirSource, "default");
});

it("reads a pre-2.0 path that is a file as holding nothing", async () => {
  writeFileSync(join(home, "shigomori"), "");
  assert.equal((await resolve()).dataDirSource, "default");
});
