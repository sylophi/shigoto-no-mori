// A tree copied as a worktree move, a carry-over and a data-folder move
// copy one: into a staging folder, then renamed in. A link to a folder
// inside it still reads once the copy lands and the source is gone. On
// Windows the link is a junction, which holds an absolute path (pnpm's
// node_modules is full of them), elsewhere a relative link, as pnpm's.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "../src/canonicalPath.ts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { it } from "vitest";
import { copyTree } from "../src/entries.ts";
import * as NodeServices from "./lib/nodeServices.ts";

it("keeps a link inside a copied tree reading once the copy is renamed in", async () => {
  const root = mkdtempSync(join(tmpdir(), "entries-"));
  try {
    const from = join(root, "from");
    const dep = join(from, "node_modules", ".pnpm", "dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "index.js"), "dep\n");
    symlinkSync(
      process.platform === "win32" ? dep : ".pnpm/dep",
      join(from, "node_modules", "dep"),
      "junction",
    );
    const staged = join(root, "to.partial");
    const landsAt = join(root, "to");
    await Effect.runPromise(
      Effect.flatMap(
        Effect.service(ChildProcessSpawner.ChildProcessSpawner),
        (spawner) => copyTree(spawner, from, staged, landsAt),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    renameSync(staged, landsAt);
    rmSync(from, { recursive: true });
    assert.equal(
      readFileSync(join(landsAt, "node_modules", "dep", "index.js"), "utf8"),
      "dep\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
