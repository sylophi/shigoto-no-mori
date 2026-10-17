import assert from "node:assert/strict";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Bundle from "../src/Bundle.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// git leaves a ref a have already holds out of a bundle, so the refs
// reported are the ones the far end will find in it.
it("reports the refs the bundle holds, not one a have already has", async () => {
  const repo = box.repo("repo", { "a.txt": "a\n" });
  box.git(repo, "branch", "kept");
  const have = box.git(repo, "rev-parse", "HEAD").trim();
  box.git(repo, "commit", "-q", "--allow-empty", "-m", "next");
  const branch = box.git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const made = (await box.engine(
    Effect.flatMap(Effect.service(Bundle.Bundle), (bundle) =>
      bundle.create(
        repo,
        join(repo, "out.bundle"),
        [`refs/heads/${branch}`, "refs/heads/kept"],
        [have],
      ),
    ),
  )) as { refs: ReadonlyArray<{ ref: string }> };
  assert.deepEqual(
    made.refs.map(({ ref }) => ref),
    [`refs/heads/${branch}`],
  );
});
