// `worktrees create` on a data dir reached through a symlink (/tmp on
// macOS, or a data dir linked to another drive), where git lists the
// new worktree under the resolved path (real git on a sandbox).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox | undefined;
let links: string | undefined;
afterEach(async () => {
  await box?.remove();
  if (links !== undefined) rmSync(links, { recursive: true, force: true });
});

it("creates a worktree under a data dir behind a symlink", async () => {
  links = mkdtempSync(join(tmpdir(), "engine-links-"));
  const real = join(links, "real");
  mkdirSync(real);
  const dataDir = join(links, "data");
  symlinkSync(real, dataDir);
  box = sandbox({ env: { SHIGOMORI_DATA_DIR: dataDir } });
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const created = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      return yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
    }),
  )) as { worktree?: Worktrees.WorktreeRow; error?: string };
  assert.equal(created.error, undefined);
  assert.equal(created.worktree?.branch, "fox");
  assert.equal(created.worktree?.isExternal, false);
});
