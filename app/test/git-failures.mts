// Durable proof for how a failed git the engine ran reads in the host:
// as a call's failure on the device link (hostCallFailure, which both
// of the host's registrars hand their handlers' failures to) and as
// text for a log line or a status (errorWordsOf). Against a real git
// in a scratch repository. Asserted: a git that failed crosses as
// RemoteCallError in git's own words, and reads in them, where the
// engine's error says only how git exited; a refusal the contract
// knows (an unmerged branch's safe delete) crosses as its class; any
// other failure reads and crosses as its message.
//
// Run: pnpm test git-failures.
//
// covers: app/host/lib/engine.ts
// covers: app/host/lib/errorWords.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  isBranchNotMergedError,
  isRemoteCallError,
} from "@shigomori/contracts/errors";
import * as Git from "@shigomori/engine/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, it } from "vitest";
import { hostCallFailure } from "@host/lib/engine";
import { errorWordsOf } from "@host/lib/errorWords";
import { sandboxGit, scrubProcessGitEnv } from "./lib/checkKit.mts";

// The engine's git runs in this process, so it must not see the
// pre-commit hook's GIT_DIR and GIT_INDEX_FILE for the real repository.
scrubProcessGitEnv();

const runtime = ManagedRuntime.make(
  Git.layer.pipe(Layer.provideMerge(NodeServices.layer)),
);
const repo = mkdtempSync(join(tmpdir(), "sm-git-failures-"));
afterAll(async () => {
  await runtime.dispose();
  rmSync(repo, { recursive: true, force: true });
});

const inSandbox = sandboxGit();
const git = (...args: string[]) => inSandbox(repo, ...args);
git("init", "-q", "-b", "main");
git("commit", "-q", "--allow-empty", "-m", "seed");

const failureOf = <A, E>(effect: Effect.Effect<A, E, Git.Git>) =>
  runtime.runPromise(Effect.flip(effect));

it("a git that failed crosses and reads in git's own words", async () => {
  const error = await failureOf(
    Effect.flatMap(Git.Git, (g) => g.checkoutBranch(repo, "no-such-branch")),
  );
  assert.ok(error instanceof Git.GitCommandError);
  assert.match(error.message, /^git checkout exited with \d+\.$/);
  const words = /invalid reference: no-such-branch/;
  assert.match(errorWordsOf(error), words);
  const crossed = hostCallFailure(error);
  assert.ok(isRemoteCallError(crossed));
  assert.match(crossed.message, words);
});

it("an unmerged branch's safe delete crosses as the contract's refusal", async () => {
  git("checkout", "-q", "-b", "feat");
  writeFileSync(join(repo, "f.txt"), "f\n");
  git("add", ".");
  git("commit", "-q", "-m", "f");
  git("checkout", "-q", "main");
  const error = await failureOf(
    Effect.flatMap(Git.Git, (g) =>
      g.deleteBranch({ repo, name: "feat", force: false }),
    ),
  );
  const crossed = hostCallFailure(error);
  assert.ok(isBranchNotMergedError(crossed));
  assert.equal(crossed.branch, "feat");
});

it("any other failure reads and crosses as its message", () => {
  const error = new Error("something else");
  assert.equal(errorWordsOf(error), "something else");
  const crossed = hostCallFailure(error);
  assert.ok(isRemoteCallError(crossed));
  assert.equal(crossed.message, "something else");
});
