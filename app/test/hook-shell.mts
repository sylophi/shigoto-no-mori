// Proof for the shell-hook probe (host/lib/cli/shell.ts): a login shell
// that answered keeps its answer, and one that failed is asked again,
// whatever it printed before failing.
//
// Run: pnpm test hook-shell.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import { childDefaults } from "@shigomori/engine/processes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, it } from "vitest";
import { HookShell, layer } from "../host/lib/cli/shell.ts";
import { makeTracker, tempDir } from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();
afterAll(teardown);

// A login shell that prints the probe's answer, notes each run, and
// exits with `code`.
const shellExiting = (code: number) => {
  const dir = tempDir("sm-hook-shell-", track);
  const runs = join(dir, "runs");
  writeFileSync(runs, "");
  const shell = join(dir, "zsh");
  writeFileSync(
    shell,
    `#!/bin/sh\necho run >> '${runs}'\nprintf '__SHIGOMORI_HOOK_ENV__/zdot\\037/xdg'\nexit ${code}\n`,
  );
  chmodSync(shell, 0o755);
  return {
    shell,
    runs: () => readFileSync(runs, "utf8").split("\n").length - 1,
  };
};

const readTwice = (shell: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { read } = yield* HookShell;
      return [yield* read, yield* read];
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.succeed(
              Lifecycle.Lifecycle,
              Lifecycle.Lifecycle.of({
                run: () => Effect.die("no scripts here"),
                loginShell: Effect.succeed({ shell, args: ["-l"] }),
              }),
            ),
          ),
          Layer.provide(childDefaults),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

it("keeps a login shell's answer, and asks again after one that failed", async () => {
  const ok = shellExiting(0);
  const [first] = await readTwice(ok.shell);
  assert.deepEqual(first, {
    zdotdir: "/zdot",
    configHome: "/xdg",
    loginShell: ok.shell,
  });
  assert.equal(ok.runs(), 1);
  const failing = shellExiting(1);
  const [unread] = await readTwice(failing.shell);
  assert.deepEqual(unread, { zdotdir: "", loginShell: failing.shell });
  assert.equal(failing.runs(), 2);
});
