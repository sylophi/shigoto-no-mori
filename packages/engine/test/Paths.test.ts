import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, it } from "vitest";
import * as Paths from "../src/Paths.ts";
import { JOURNAL } from "../src/dataDirMoveJournal.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "engine-paths-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const resolve = () =>
  Effect.service(Paths.Paths).pipe(
    Effect.provide(
      Paths.layer("prod").pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
        ),
      ),
    ),
    Effect.runPromise,
  );

it("passes over a pointer at a folder of someone else's files", async () => {
  mkdirSync(join(home, "Documents"));
  writeFileSync(join(home, "Documents", "notes.txt"), "");
  mkdirSync(join(home, ".config", "shigomori"), { recursive: true });
  writeFileSync(
    join(home, ".config", "shigomori", "data-dir"),
    `${join(home, "Documents")}\n`,
  );
  assert.equal((await resolve()).dataDirSource, "default");
});

it("refuses to resolve a data dir a rename landed whose pointer can't be written", async () => {
  const moved = join(home, "drive", ".sm");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, "store.db"), "");
  writeFileSync(
    join(moved, JOURNAL),
    JSON.stringify({
      from: join(home, ".sm"),
      to: moved,
      partial: null,
      moved: [],
    }),
  );
  const config = join(home, ".config", "shigomori");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "data-dir.tmp.ab12"), `${moved}\n`);
  chmodSync(config, 0o555);
  try {
    await assert.rejects(resolve(), { _tag: "DataDirStranded" });
  } finally {
    chmodSync(config, 0o755);
  }
});

it("refuses to resolve when a pre-2.0 pointer to the folder that left can't be removed", async () => {
  // Moved back to the default: the folder there holds the journal, and
  // only the pre-2.0 pointer still names the folder that left.
  const left = join(home, "drive", ".sm");
  const back = join(home, ".sm");
  mkdirSync(back, { recursive: true });
  writeFileSync(join(back, "store.db"), "");
  writeFileSync(
    join(back, JOURNAL),
    JSON.stringify({ from: left, to: back, partial: null, moved: [] }),
  );
  const config = join(home, ".config", "shigomori");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "root"), `${left}\n`);
  chmodSync(config, 0o555);
  try {
    await assert.rejects(resolve(), { _tag: "DataDirStranded" });
  } finally {
    chmodSync(config, 0o755);
  }
});
