import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, it } from "vitest";
import * as Icons from "../src/Icons.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const iconOf = (path: string, rescanMisses = false) =>
  box.engine(
    Effect.service(Icons.Icons).pipe(
      Effect.flatMap((icons) => icons.of(path, { rescanMisses })),
      Effect.map(Option.getOrNull),
    ),
  );

it("remembers a project without an icon until asked to look again", async () => {
  const repo = box.repo("repo");
  assert.equal(await iconOf(repo), null);
  mkdirSync(join(repo, "public"));
  writeFileSync(join(repo, "public", "favicon.png"), "png");
  assert.equal(await iconOf(repo), null);
  assert.deepEqual(await iconOf(repo, true), {
    path: join(repo, "public", "favicon.png"),
    mime: "image/png",
  });
});

it("looks again when the remembered icon is gone", async () => {
  const repo = box.repo("repo", {
    "favicon.svg": "<svg/>",
    "assets/icon.png": "png",
  });
  assert.equal(
    ((await iconOf(repo)) as { path: string }).path,
    join(repo, "favicon.svg"),
  );
  rmSync(join(repo, "favicon.svg"));
  assert.equal(
    ((await iconOf(repo)) as { path: string }).path,
    join(repo, "assets", "icon.png"),
  );
});
