// Durable proof for the git library as Effects (host/lib/git/*,
// host/lib/worktrees/hygiene.ts) and the handlers over it, against REAL
// sandbox repositories: git's "not fully merged" refusal fails typed as
// BranchNotMerged through the branches handler and `force` deletes. A
// caller leaving a worktrees:list interrupts the row probes and kills
// every git they started, with the process-wide row window holding.
// overlapping fetchAllRemotes calls on one project share one git, a
// caller leaving does not stop it for the others, the last one leaving
// kills it, and a failure is never served to a later caller. Index
// writes on one worktree run one after another while writes on two
// worktrees run at once, and a failed write frees the turn.
//
// Every git the library starts goes through a `git` shim first on the
// PATH. It logs each run (pid, subcommand, working directory), holds the
// subcommands SM_SHIM_HOLD names until killed, and slows the ones
// SM_SHIM_SLOW names, logging when the real git ends. The sandbox's own
// setup git runs under the environment captured before the shim.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test git-lib.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import {
  alive,
  delay,
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  waitFor,
} from "./lib/checkKit.mjs";

// The library reads process.env at every spawn: the pre-commit hook's
// GIT_* variables would point its git at the commit in progress, so
// they go, and the scrubbed copy (real git on its PATH) is what the
// sandbox setup runs under.
const gitEnv = scrubbedGitEnv();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_AUTHOR_NAME = "sm";
process.env.GIT_AUTHOR_EMAIL = "sm@example.test";
process.env.GIT_COMMITTER_NAME = "sm";
process.env.GIT_COMMITTER_EMAIL = "sm@example.test";
const git = sandboxGit(gitEnv);

const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-git-lib-")));
const shimLog = join(root, "shim.log");

// The shim. `$$` is the pid the runner spawned (the shell execs
// nothing while it holds), so a kill of the run is a kill of that pid.
const realGit = execFileSync("sh", ["-c", "command -v git"], {
  env: gitEnv,
  encoding: "utf8",
}).trim();
const shimDir = join(root, "bin");
mkdirSync(shimDir);
writeFileSync(
  join(shimDir, "git"),
  `#!/bin/sh
sub=""
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -c|-C) skip=1 ;;
    -*) ;;
    *) sub="$arg"; break ;;
  esac
done
where=$(pwd -P)
for last in "$@"; do :; done
case " $SM_SHIM_HOLD " in
  *" $sub "*)
    echo "hold $$ $sub $where" >> "${shimLog}"
    while :; do sleep 0.05; done ;;
esac
case " $SM_SHIM_SLOW " in
  *" $sub "*)
    echo "start $$ $sub $where $last" >> "${shimLog}"
    sleep 0.4
    "${realGit}" "$@"
    code=$?
    echo "end $$ $sub $where $last" >> "${shimLog}"
    exit $code ;;
esac
echo "run $$ $sub $where" >> "${shimLog}"
exec "${realGit}" "$@"
`,
);
chmodSync(join(shimDir, "git"), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const { initDataDirAt } = await import("../host/lib/util/paths.ts");
const { PROJECTS_KEY, registryStore } =
  await import("../host/lib/config/store.ts");
const { BranchNotMerged, isBranchNotMergedError, UNKNOWN_PROJECT_TAG } =
  await import("../shared/errors.ts");
const { encodeWireError } = await import("../shared/ipc/wireError.ts");
const { deleteAnyLocalBranchEffect } =
  await import("../host/lib/git/branches.ts");
const { fetchAllRemotes, fetchAllRemotesEffect } =
  await import("../host/lib/git/remotes.ts");
const { setStaged } = await import("../host/lib/git/changes.ts");
const { branchesHandlers } = await import("../host/ipc/modules/branches.ts");
const { worktreesHandlers } = await import("../host/ipc/modules/worktrees.ts");

const { check, done, fail } = makeProof("git-lib proof");

initDataDirAt(join(root, "data"));

// A handler's context: the caller's signal, and notifiers nobody reads.
function ctxFor(signal = new AbortController().signal) {
  return { signal, notifier: () => () => {} };
}

function shimLines() {
  try {
    return readFileSync(shimLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function resetShim(track) {
  writeFileSync(shimLog, "");
  track(() => {
    delete process.env.SM_SHIM_HOLD;
    delete process.env.SM_SHIM_SLOW;
  });
}

// Whatever a check held, gone by its end, however the check went.
function reapHeld(track) {
  track(() => {
    for (const line of shimLines()) {
      const [kind, pid] = line.split(" ");
      if (kind === "hold" && alive(Number(pid))) {
        process.kill(Number(pid), "SIGKILL");
      }
    }
  });
}

let sandboxes = 0;
function repo(track) {
  const dir = join(root, `repo-${++sandboxes}`);
  git(root, "init", "-q", "-b", "main", dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  track(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function register(...dirs) {
  const projects = dirs.map((dir, i) => ({
    id: `p${sandboxes}-${i}`,
    name: `p${sandboxes}-${i}`,
    path: dir,
  }));
  registryStore.writeKey(PROJECTS_KEY, projects);
  return projects.length === 1 ? projects[0] : projects;
}

async function main() {
  console.log("git-lib proof\n");

  await check(
    "deleting an unmerged branch fails as BranchNotMerged (tag and branch field, on the Effect form and through the handler onto the wire), and force deletes it",
    async (track) => {
      resetShim(track);
      const dir = repo(track);
      const project = register(dir);
      git(dir, "checkout", "-q", "-b", "feature");
      writeFileSync(join(dir, "feature.txt"), "work\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "feature work");
      git(dir, "checkout", "-q", "main");

      const typed = await Effect.runPromise(
        Effect.flip(deleteAnyLocalBranchEffect(dir, "feature", false)),
      );
      assert.ok(typed instanceof BranchNotMerged, `not typed: ${typed}`);
      assert.equal(typed._tag, "BranchNotMerged");
      assert.ok(Object.hasOwn(typed, "_tag"), "_tag is not an own property");
      assert.equal(typed.branch, "feature");

      const rejection = await branchesHandlers
        .delete({ projectId: project.id, name: "feature" }, ctxFor())
        .then(
          () => null,
          (error) => error,
        );
      assert.ok(
        rejection instanceof BranchNotMerged,
        `handler rejected with ${rejection}`,
      );
      assert.equal(rejection.branch, "feature");
      assert.ok(isBranchNotMergedError(rejection));
      const wire = encodeWireError(rejection);
      assert.equal(wire?._tag, "BranchNotMerged");
      assert.equal(wire?.branch, "feature");
      // Still there after the refusal.
      git(dir, "show-ref", "--verify", "--quiet", "refs/heads/feature");

      const forced = await branchesHandlers.delete(
        { projectId: project.id, name: "feature", force: true },
        ctxFor(),
      );
      assert.equal(forced, undefined);
      assert.throws(() =>
        git(dir, "show-ref", "--verify", "--quiet", "refs/heads/feature"),
      );

      // An id the registry does not hold fails typed before any git.
      await assert.rejects(
        branchesHandlers.delete({ projectId: "nope", name: "x" }, ctxFor()),
        (error) => error._tag === UNKNOWN_PROJECT_TAG,
      );
    },
  );

  await check(
    "a caller leaving worktrees:list interrupts the row probes: every git they started dies, nothing starts after, at most six rows probe at once across two lists, and the window is whole again after",
    async (track) => {
      resetShim(track);
      reapHeld(track);
      const dir = repo(track);
      const other = repo(track);
      const [project, second] = register(dir, other);
      for (let i = 0; i < 8; i++) {
        git(dir, "worktree", "add", "-q", "-b", `wt${i}`, join(dir, `.wt${i}`));
        git(
          other,
          "worktree",
          "add",
          "-q",
          "-b",
          `o${i}`,
          join(other, `.o${i}`),
        );
      }
      // The row probes hold. The identity listing and the project-level
      // reads run through. Two lists at once: the window is the
      // process's, not each call's (each call bounds itself to six as
      // well, so one list alone would not tell the two apart).
      process.env.SM_SHIM_HOLD = "status log rev-list merge-tree";
      const controller = new AbortController();
      const began = performance.now();
      const pending = Promise.all([
        worktreesHandlers.list(
          { projectId: project.id },
          ctxFor(controller.signal),
        ),
        worktreesHandlers.list(
          { projectId: second.id },
          ctxFor(controller.signal),
        ),
      ]);
      const held = () =>
        shimLines()
          .filter((line) => line.startsWith("hold "))
          .map((line) => line.split(" "));
      await waitFor(() => held().length >= 6, "the row probes to start");
      // Let the window fill, so the bound is checked at its fullest.
      await delay(300);
      const rows = new Set(held().map((fields) => fields[3]));
      assert.ok(
        rows.size <= 6,
        `${rows.size} rows probed at once, over the window of six`,
      );
      const pids = held().map((fields) => Number(fields[1]));
      assert.ok(pids.every(alive), "a held git died before the abort");
      controller.abort();
      await assert.rejects(pending);
      const took = performance.now() - began;
      assert.ok(took < 5_000, `the abort did not end the list (${took}ms)`);
      await waitFor(
        () => pids.every((pid) => !alive(pid)),
        "every probe's git to be gone",
      );
      const before = shimLines().length;
      await delay(400);
      assert.equal(
        shimLines().length,
        before,
        "git started after the caller left",
      );
      // The permits the interrupted probes held came back: a fresh
      // list of nine rows runs through with nothing held.
      delete process.env.SM_SHIM_HOLD;
      const fresh = await worktreesHandlers.list(
        { projectId: project.id },
        ctxFor(),
      );
      assert.equal(fresh.length, 9, "a list after the abort came up short");
    },
  );

  await check(
    "overlapping fetchAllRemotes calls on one project share one git; one caller leaving does not stop it for the rest, the last one leaving kills it, and a failure is never served again",
    async (track) => {
      resetShim(track);
      reapHeld(track);
      const dir = repo(track);
      git(dir, "remote", "add", "origin", "ssh://stub.invalid/repo.git");
      const sshLog = join(root, "ssh.log");
      writeFileSync(sshLog, "");
      // The stub waits SM_SSH_TENTHS tenths of a second, in steps, and
      // only while its git (the parent) is alive: a killed fetch takes
      // the stub with it rather than leaving a sleep behind. "done"
      // is logged only when the wait ran its course, so a caller's
      // outcome can be told from a kill.
      process.env.GIT_SSH_COMMAND = `sh -c 'echo x >> "${sshLog}"; n=0; while [ $n -lt \${SM_SSH_TENTHS:-5} ] && kill -0 $PPID 2>/dev/null; do sleep 0.1; n=$((n+1)); done; [ $n -ge \${SM_SSH_TENTHS:-5} ] && echo done >> "${sshLog}"; exit 1' ssh-stub`;
      // Plain ssh semantics, so git runs the command once per fetch
      // rather than probing its flavor with a first run.
      process.env.GIT_SSH_VARIANT = "simple";
      track(() => {
        delete process.env.GIT_SSH_COMMAND;
        delete process.env.GIT_SSH_VARIANT;
        delete process.env.SM_SSH_TENTHS;
      });
      const fetches = () =>
        shimLines().filter((line) => line.split(" ")[2] === "fetch");
      const sshLines = () => readFileSync(sshLog, "utf8").split("\n");
      const sshRuns = () => sshLines().filter((line) => line === "x").length;
      const sshDone = () => sshLines().filter((line) => line === "done").length;

      // Three at once: one git, one ssh, and all three see its failure.
      const settled = await Promise.allSettled([
        fetchAllRemotes(dir),
        fetchAllRemotes(dir),
        fetchAllRemotes(dir),
      ]);
      assert.ok(
        settled.every((s) => s.status === "rejected"),
        "a joined caller did not see the fetch's failure",
      );
      assert.equal(settled[0].reason._tag, "GitError");
      assert.equal(fetches().length, 1, `${fetches().length} fetches ran`);
      assert.equal(sshRuns(), 1);

      // The failure is not kept: the next call fetches again.
      await assert.rejects(fetchAllRemotes(dir));
      assert.equal(fetches().length, 2, "a failed fetch was served again");

      // Two callers join. The first leaves. The second still gets the
      // one fetch's own outcome, not an interruption.
      process.env.SM_SSH_TENTHS = "6";
      const first = Effect.runFork(fetchAllRemotesEffect(dir));
      const second = Effect.runFork(Effect.flip(fetchAllRemotesEffect(dir)));
      await waitFor(() => fetches().length === 3, "the joined fetch to start");
      await Effect.runPromise(Fiber.interrupt(first));
      const outcome = await Effect.runPromise(Fiber.join(second));
      assert.equal(outcome._tag, "GitError", `second got ${outcome}`);
      assert.equal(fetches().length, 3, "the leaving caller forked a fetch");
      assert.equal(sshDone(), 3, "the shared fetch did not run its course");

      // A lone caller leaving takes the fetch with it: its git dies.
      process.env.SM_SSH_TENTHS = "300";
      const lone = Effect.runFork(fetchAllRemotesEffect(dir));
      await waitFor(() => fetches().length === 4, "the lone fetch to start");
      const pid = Number(fetches().at(-1).split(" ")[1]);
      await waitFor(() => sshRuns() === 4, "the fetch to reach the remote");
      assert.ok(alive(pid), "the fetch's git is not running");
      await Effect.runPromise(Fiber.interrupt(lone));
      await waitFor(() => !alive(pid), "the abandoned fetch's git to be gone");
      await delay(300);
      assert.equal(sshDone(), 3, "the killed fetch's ssh ran its course");
    },
  );

  await check(
    "index writes on one worktree run one after the other, writes on two worktrees run at once, and a failed write frees the turn",
    async (track) => {
      resetShim(track);
      const dir = repo(track);
      const other = join(dir, ".other");
      git(dir, "worktree", "add", "-q", "-b", "other", other);
      for (const name of ["a.txt", "b.txt"]) {
        writeFileSync(join(dir, name), `${name}\n`);
      }
      writeFileSync(join(other, "c.txt"), "c\n");
      process.env.SM_SHIM_SLOW = "add";
      // Where each slowed `add` began and ended, in log order.
      const adds = () =>
        shimLines()
          .map((line) => line.split(" "))
          .filter(
            ([kind, , sub]) =>
              (kind === "start" || kind === "end") && sub === "add",
          )
          .map(([kind, , , where]) => ({ kind, where }));

      // One worktree: the second add starts only after the first ended.
      const [one, two] = await Promise.all([
        setStaged(dir, ["a.txt"], true),
        setStaged(dir, ["b.txt"], true),
      ]);
      assert.deepEqual(
        adds().map((a) => a.kind),
        ["start", "end", "start", "end"],
        "two writes on one worktree overlapped",
      );
      assert.ok(one.some((f) => f.path === "a.txt" && f.staged === "all"));
      // The later answer is the complete one.
      assert.ok(
        ["a.txt", "b.txt"].every((path) =>
          two.some((f) => f.path === path && f.staged === "all"),
        ),
      );

      // Two worktrees: both adds start before either ends.
      writeFileSync(shimLog, "");
      writeFileSync(join(dir, "d.txt"), "d\n");
      await Promise.all([
        setStaged(dir, ["d.txt"], true),
        setStaged(other, ["c.txt"], true),
      ]);
      const kinds = adds().map((a) => a.kind);
      assert.deepEqual(
        kinds.slice(0, 2),
        ["start", "start"],
        `writes on two worktrees ran one after the other: ${kinds}`,
      );
      assert.equal(new Set(adds().map((a) => a.where)).size, 2);

      // Writes on one worktree run in the order they were called: a
      // write that arrives while earlier ones are still queued goes to
      // the back, even when it arrives in the instant a turn ends (a
      // permit-style lock would let it jump the queue, and a tick,
      // untick, tick on one file would land unticked).
      writeFileSync(shimLog, "");
      for (const name of ["f.txt", "g.txt", "h.txt", "i.txt"]) {
        writeFileSync(join(dir, name), `${name}\n`);
      }
      const queued = ["f.txt", "g.txt", "h.txt"].map((name) =>
        setStaged(dir, [name], true),
      );
      await waitFor(
        () => shimLines().some((line) => line.startsWith("end ")),
        "the first queued add to end",
      );
      await Promise.all([...queued, setStaged(dir, ["i.txt"], true)]);
      assert.deepEqual(
        shimLines()
          .map((line) => line.split(" "))
          .filter(([kind, , sub]) => kind === "start" && sub === "add")
          .map(([, , , , last]) => last),
        ["f.txt", "g.txt", "h.txt", "i.txt"],
        "index writes ran out of call order",
      );

      // A write that fails releases the lock for the next one.
      delete process.env.SM_SHIM_SLOW;
      await assert.rejects(setStaged(dir, ["no-such-file.txt"], true));
      writeFileSync(join(dir, "e.txt"), "e\n");
      const after = await setStaged(dir, ["e.txt"], true);
      assert.ok(after.some((f) => f.path === "e.txt" && f.staged === "all"));
    },
  );

  done();
}

main()
  .catch(fail)
  .finally(() => rmSync(root, { recursive: true, force: true }));
