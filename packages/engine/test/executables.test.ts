// Finding a program on PATH as a shell would, by what this process may
// execute rather than any execute bit.
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
import * as Option from "effect/Option";
import { afterEach, beforeEach, it } from "vitest";
import { findExecutable } from "../src/executables.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-executables-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const program = (dir: string, mode: number) => {
  mkdirSync(join(root, dir));
  const file = join(root, dir, "tool");
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, mode);
  return file;
};

it("passes over a program its owner may not execute for a later one that runs", async () => {
  program("first", 0o641);
  const runs = program("second", 0o755);
  const found = await Effect.runPromise(
    findExecutable("tool").pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { PATH: `${join(root, "first")}:${join(root, "second")}` },
            }),
          ),
        ),
      ),
    ),
  );
  assert.deepEqual(found, Option.some(runs));
});
