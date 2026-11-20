// A clone that fails or is cancelled once git has kept its folder
// leaves nothing behind, so the next try isn't refused.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "../src/canonicalPath.ts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Git from "../src/Git.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

it("a clone whose checkout fails leaves no folder, and the next try clones", async () => {
  const source = box.repo("source", { ".gitattributes": "* filter=boom\n" });
  const parentDir = dirname(source);
  const clone = (config: ReadonlyArray<readonly [string, string]>) =>
    box.engine(
      Effect.flatMap(Effect.service(Git.Git), (git) =>
        git.clone({ url: source, parentDir, name: "copy", config }),
      ).pipe(Effect.isSuccess),
    ) as Promise<boolean>;

  // A required filter that fails stops git after it kept the repository.
  const failed = await clone([
    ["filter.boom.smudge", "false"],
    ["filter.boom.required", "true"],
  ]);
  assert.equal(failed, false);
  assert.equal(existsSync(join(parentDir, "copy")), false);

  assert.equal(await clone([]), true);
});
