// Durable proof for the git runner (host/lib/git/core.ts) as an
// Effect: a run that never finishes is killed at its timeout and fails
// typed, a caller's cancellation (the signal a contract handler runs
// under, shared/ipc/effectHandler.ts) kills it at once, git that
// cannot start fails as GitSpawnError with Node's errno, and the
// Promise form still rejects with the same classes. Real git, real
// child processes: the hang is `git ls-remote` over an ssh command that
// sleeps, which is what a remote that never answers looks like.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test git-runner.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  GitError,
  GitSpawnError,
  run,
  runEffect,
  runLenient,
} from "@host/lib/git/core";
import { fromEffectWith } from "@shared/ipc/effectHandler";
import {
  alive,
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  waitFor,
} from "./lib/checkKit.mjs";

// The runner reads process.env: this check runs from the pre-commit
// hook, whose GIT_* variables would point every git below at the
// commit in progress, so they go before anything is imported.
const gitEnv = scrubbedGitEnv();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("git-runner proof");

// A remote git can only reach through an ssh command that sleeps: the
// run blocks in the transport, exactly like a remote that never
// answers. Git appends the host and the remote command to the ssh
// command, which `sh -c` takes as positional parameters and ignores.
// The stub records git's pid (its parent) in the sandbox, so a check
// can prove git is gone afterwards, and it outlives nothing: it polls
// that parent and exits once git is gone, so a killed run leaves no
// orphan behind the proof, and while git lives only the runner's own
// bound can end the run.
function hang(dir) {
  const pidFile = join(dir, "git.pid");
  return {
    args: ["ls-remote", "ssh://hang.invalid/repo.git"],
    env: {
      ...gitEnv,
      GIT_SSH_COMMAND: `sh -c 'echo $PPID > "${pidFile}"; while kill -0 $PPID 2>/dev/null; do sleep 0.1; done' ssh-stub`,
    },
    // The git pid the stub wrote, once it has; null before.
    pid: () => {
      try {
        return Number(readFileSync(pidFile, "utf8").trim());
      } catch {
        return null;
      }
    },
  };
}

function sandbox(track) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sm-git-runner-")));
  track(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

// Whatever git a check started, gone by its end, however the check
// went.
function reap(track, hung) {
  track(() => {
    const pid = hung.pid();
    if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL");
  });
}

async function main() {
  console.log("git-runner proof\n");

  await check(
    "timeout: a run that never finishes is killed at its bound and fails as a GitError that names the timeout",
    async (track) => {
      const dir = sandbox(track);
      const hung = hang(dir);
      reap(track, hung);
      const began = performance.now();
      const outcome = await Effect.runPromise(
        runEffect(dir, hung.args, { env: hung.env, timeoutMs: 300 }).pipe(
          Effect.map(() => "finished"),
          Effect.catch((error) => Effect.succeed(error)),
        ),
      );
      const took = performance.now() - began;
      assert.ok(outcome instanceof GitError, `not a GitError: ${outcome}`);
      // Git may answer the kill with its own exit code and message; the
      // timeout is named first either way.
      assert.match(outcome.message, /^git did not finish within/);
      assert.ok(took < 5_000, `the timeout did not end the run (${took}ms)`);
      await waitFor(() => !alive(hung.pid()), "git to be gone");
    },
  );

  await check(
    "cancellation: a handler's caller going away interrupts the run, which kills git at once",
    async (track) => {
      const dir = sandbox(track);
      const hung = hang(dir);
      reap(track, hung);
      const controller = new AbortController();
      const handler = fromEffectWith(
        () => ({ runPromise: Effect.runPromise }),
        () => runEffect(dir, hung.args, { env: hung.env, timeoutMs: 20_000 }),
      );
      const began = performance.now();
      const pending = handler(undefined, { signal: controller.signal });
      // Abort once git is provably running (the stub has written its
      // pid), so the kill is of a live process, not a race with spawn.
      await waitFor(() => {
        const pid = hung.pid();
        return pid !== null && alive(pid);
      }, "git to start");
      const pid = hung.pid();
      controller.abort();
      await assert.rejects(pending);
      const took = performance.now() - began;
      assert.ok(
        took < 5_000,
        `the cancellation did not end the run (${took}ms)`,
      );
      // The rejection is the fiber giving up on the promise; the kill
      // is what the signal did to git, proven by the pid.
      await waitFor(() => !alive(pid), "the cancelled git to be gone");
      // A caller already gone never starts a run.
      await assert.rejects(
        handler(undefined, { signal: AbortSignal.abort() }),
        /caller is gone/,
      );
    },
  );

  await check(
    "spawn failure: git that cannot start fails as GitSpawnError carrying Node's errno, on the Effect and the Promise form alike",
    async (track) => {
      const dir = sandbox(track);
      const missing = join(dir, "nowhere");
      const typed = await Effect.runPromise(
        runEffect(missing, ["status"]).pipe(
          Effect.map(() => null),
          Effect.catch((error) => Effect.succeed(error)),
        ),
      );
      assert.ok(
        typed instanceof GitSpawnError,
        `not a GitSpawnError: ${typed}`,
      );
      assert.equal(typed.code, "ENOENT");
      assert.equal(typed.message.includes("ENOENT"), true);
      await assert.rejects(
        run(missing, ["status"]),
        (error) => error instanceof GitSpawnError && error.code === "ENOENT",
      );
    },
  );

  await check(
    "failure and leniency: a non-zero exit is a GitError with git's stderr, the Promise form rejects with the same instance kind, and runLenient answers with the stdout",
    async (track) => {
      const dir = sandbox(track);
      await assert.rejects(
        run(dir, ["rev-parse", "--verify", "no-such-ref"]),
        (error) =>
          error instanceof GitError &&
          error.exitCode !== 0 &&
          error.stderr.length > 0 &&
          error.message === error.stderr.trim(),
      );
      // `git diff --no-index` exits 1 when the two differ, printing
      // the diff: the lenient form hands the stdout over.
      const stdout = await runLenient(dir, [
        "diff",
        "--no-index",
        "--",
        "/dev/null",
        join(dir, ".git", "HEAD"),
      ]);
      assert.match(stdout, /ref: refs\/heads\/main/);
      const ok = await run(dir, ["rev-parse", "--git-dir"]);
      assert.equal(ok.trim(), ".git");
    },
  );

  done();
}

main().catch(fail);
