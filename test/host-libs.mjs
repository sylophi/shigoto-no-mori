// Durable proof for the host libraries that moved onto Effect in
// Phase 3 (EFFECT-MIGRATION.md):
//   - the project icon lookup (host/lib/projects/icon.ts): concurrent
//     lookups for one project share one resolution, a failed resolution
//     is shared by the callers that joined it and never answers a later
//     lookup, and the write-behind persist keeps landing (the promise
//     coalescer it replaced wrote the index once per process).
//   - the directory walk (host/lib/util/dirSize.ts): never more than 8
//     directory reads in flight, across one walk and across concurrent
//     walks, and the total is right.
//   - the gh runner (host/lib/githubCli/exec.ts), against a stub `gh`
//     on PATH: the timeout kills a run that never finishes and fails as
//     a GhError that says so, a cancelled Effect kills the child at
//     once, a non-zero exit is a GhError with gh's own words, gh that
//     cannot start is GhSpawnError, and the Promise form rejects with
//     the same classes.
// The counts come from spies on node:fs/promises (live ESM bindings
// resynced with syncBuiltinESMExports), so the code under test runs
// unmodified.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test host-libs.
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import {
  execGh,
  execGhEffect,
  GhError,
  GhSpawnError,
} from "@host/lib/githubCli/exec";
import { readProjectIcon } from "@host/lib/projects/icon";
import { measureDirectory } from "@host/lib/util/dirSize";
import { initDataDirAt } from "@host/lib/util/paths";
import { alive, delay, makeProof, waitFor } from "./lib/checkKit.mjs";

// The icon lookup asks git for the project's files: the pre-commit
// hook's GIT_* variables would point it at the commit in progress.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// The fs spies. Each hook sees the real function and the call's
// arguments. Unset, the call goes straight through.
const real = { opendir: fsp.opendir, readFile: fsp.readFile };
const hooks = { opendir: null, readFile: null };
fsp.opendir = (...args) =>
  hooks.opendir ? hooks.opendir(real.opendir, ...args) : real.opendir(...args);
fsp.readFile = (...args) =>
  hooks.readFile
    ? hooks.readFile(real.readFile, ...args)
    : real.readFile(...args);
syncBuiltinESMExports();

const { check, done, fail } = makeProof("host-libs proof");

function sandbox(track, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  track(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An Effect's failure as a value, or "succeeded".
const failureOf = (effect) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => "succeeded"),
      Effect.catch((error) => Effect.succeed(error)),
    ),
  );

async function main() {
  console.log("host-libs proof\n");

  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "sm-host-libs-")));
  initDataDirAt(join(dataRoot, "data"));

  try {
    await check(
      "icon: concurrent lookups for one project share one resolution, a failure is shared but never cached, and every persist lands",
      async (track) => {
        track(() => {
          hooks.readFile = null;
        });
        const root = sandbox(track, "sm-icon-");
        const project = join(root, "alpha");
        const other = join(root, "beta");
        mkdirSync(project);
        mkdirSync(other);
        const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
        writeFileSync(join(project, "favicon.svg"), svg);
        writeFileSync(join(other, "favicon.png"), "png");
        const favicon = join(project, "favicon.svg");

        // Every read of the icon source is a resolution's. Slowed so
        // the concurrent lookups provably overlap.
        let reads = 0;
        let failNext = null;
        hooks.readFile = async (readFile, path, ...rest) => {
          if (path !== favicon) return readFile(path, ...rest);
          reads += 1;
          await delay(50);
          if (failNext !== null) {
            const error = failNext;
            failNext = null;
            throw error;
          }
          return readFile(path, ...rest);
        };

        const want = {
          mime: "image/svg+xml",
          base64: Buffer.from(svg).toString("base64"),
        };
        const first = await Promise.all(
          Array.from({ length: 5 }, () => readProjectIcon(project)),
        );
        for (const icon of first) assert.deepEqual(icon, want);
        assert.equal(reads, 1, `5 lookups made ${reads} resolutions`);

        const index = join(dataRoot, "data", "iconCache", "index.json");
        const indexed = () => {
          try {
            return Object.keys(JSON.parse(readFileSync(index, "utf8")));
          } catch {
            return [];
          }
        };
        await waitFor(
          () => indexed().includes(project),
          "the first icon to be persisted",
        );

        // A failed resolution: the callers that joined it share the
        // one failure, and the next lookup resolves afresh.
        const boom = new Error("icon source unreadable");
        failNext = boom;
        const before = reads;
        const failed = await Promise.allSettled(
          Array.from({ length: 3 }, () => readProjectIcon(project)),
        );
        for (const outcome of failed) {
          assert.equal(outcome.status, "rejected");
          assert.equal(outcome.reason, boom);
        }
        assert.equal(reads - before, 1, "the failure was not one resolution");
        assert.deepEqual(await readProjectIcon(project), want);
        assert.equal(reads - before, 2, "the failure answered a later lookup");

        // A second project, resolved after the first persist landed,
        // lands too.
        assert.equal((await readProjectIcon(other))?.mime, "image/png");
        await waitFor(
          () => indexed().includes(other) && indexed().includes(project),
          "the second icon to be persisted beside the first",
        );
      },
    );

    await check(
      "dirSize: a 51-directory walk never has more than 8 reads in flight, even beside a second walk, and the total is right",
      async (track) => {
        track(() => {
          hooks.opendir = null;
        });
        const root = sandbox(track, "sm-dirsize-");
        let expected = 0;
        for (let a = 0; a < 10; a += 1) {
          for (let b = 0; b < 4; b += 1) {
            const leaf = join(root, `d${a}`, `s${b}`);
            mkdirSync(leaf, { recursive: true });
            const file = join(leaf, "data.bin");
            writeFileSync(file, Buffer.alloc(1000 + a * 100 + b));
            const stats = lstatSync(file);
            expected += stats.blocks * 512;
          }
        }

        // A read is in flight from its opendir until its listing is
        // drained, a span inside the slot the walk holds for it.
        let inFlight = 0;
        let peak = 0;
        let opened = 0;
        hooks.opendir = async (opendir, ...args) => {
          opened += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          let dir;
          try {
            await delay(10);
            dir = await opendir(...args);
          } catch (error) {
            inFlight -= 1;
            throw error;
          }
          return {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const entry of dir) yield entry;
              } finally {
                inFlight -= 1;
              }
            },
          };
        };

        const result = await measureDirectory(root);
        assert.equal(opened, 51, `read ${opened} directories, not 51`);
        assert.ok(peak <= 8, `${peak} reads were in flight at once`);
        assert.equal(peak, 8, `the walk never used its width (peak ${peak})`);
        assert.equal(result.bytes, expected);
        assert.equal(result.partial, false);
        assert.equal(typeof result.lastActivityAt, "number");

        // The bound is shared: two walks at once still stay under it.
        peak = 0;
        const [left, right] = await Promise.all([
          measureDirectory(root),
          measureDirectory(root),
        ]);
        assert.ok(peak <= 8, `${peak} reads were in flight across two walks`);
        assert.equal(left.bytes, expected);
        assert.equal(right.bytes, expected);
        assert.equal(inFlight, 0);
      },
    );

    // A stub gh: `hang` records its pid and sleeps in place (exec keeps
    // the pid), `fail` says something on stderr and exits 4.
    function stubGh(track) {
      const dir = sandbox(track, "sm-gh-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const pidFile = join(dir, "gh.pid");
      writeFileSync(
        join(bin, "gh"),
        [
          "#!/bin/sh",
          'case "$1" in',
          `  hang) echo $$ > "${pidFile}"; exec sleep 30 ;;`,
          '  fail) echo "gh: could not resolve to a Repository" >&2; exit 4 ;;',
          "esac",
          'echo "ok $*"',
          "",
        ].join("\n"),
      );
      chmodSync(join(bin, "gh"), 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${bin}:${originalPath}`;
      track(() => {
        process.env.PATH = originalPath;
      });
      const pid = () => {
        try {
          return Number(readFileSync(pidFile, "utf8").trim()) || null;
        } catch {
          return null;
        }
      };
      // Whatever a check started, gone by its end.
      track(() => {
        const found = pid();
        if (found !== null && alive(found)) process.kill(found, "SIGKILL");
      });
      return { dir, pid, reset: () => rmSync(pidFile, { force: true }) };
    }

    await check(
      "gh timeout: a run that never finishes is killed at its bound and fails as a GhError that names the timeout, on the Effect and the Promise form alike",
      async (track) => {
        const gh = stubGh(track);
        const began = performance.now();
        const outcome = await failureOf(
          execGhEffect(["hang"], { timeout: 300 }),
        );
        const took = performance.now() - began;
        assert.ok(outcome instanceof GhError, `not a GhError: ${outcome}`);
        assert.equal(outcome._tag, "GhError");
        assert.equal(outcome.timedOut, true);
        assert.equal(outcome.message, "GitHub CLI timed out");
        assert.ok(took < 5_000, `the timeout did not end the run (${took}ms)`);
        const pid = gh.pid();
        assert.ok(pid !== null, "the stub never ran");
        await waitFor(() => !alive(pid), "the timed-out gh to be gone", 3_000);

        gh.reset();
        await assert.rejects(
          execGh(["hang"], { timeout: 300 }),
          (error) => error instanceof GhError && error.timedOut === true,
        );
      },
    );

    await check(
      "gh cancellation: interrupting the Effect form kills gh at once",
      async (track) => {
        const gh = stubGh(track);
        const began = performance.now();
        const fiber = Effect.runFork(
          execGhEffect(["hang"], { timeout: 20_000 }),
        );
        await waitFor(() => {
          const pid = gh.pid();
          return pid !== null && alive(pid);
        }, "gh to start");
        const pid = gh.pid();
        await Effect.runPromise(Fiber.interrupt(fiber));
        await waitFor(() => !alive(pid), "the cancelled gh to be gone", 3_000);
        const took = performance.now() - began;
        assert.ok(took < 5_000, `the cancellation took ${took}ms`);
      },
    );

    await check(
      "gh failures: a non-zero exit is a GhError with gh's own words, gh that cannot start is GhSpawnError with Node's errno, and a success hands the output over",
      async (track) => {
        const gh = stubGh(track);
        const failed = await failureOf(execGhEffect(["fail"]));
        assert.ok(failed instanceof GhError, `not a GhError: ${failed}`);
        assert.equal(failed.exitCode, 4);
        assert.equal(failed.timedOut, false);
        assert.equal(failed.message, "could not resolve to a Repository");
        await assert.rejects(
          execGh(["fail"]),
          (error) => error instanceof GhError && error.exitCode === 4,
        );

        const { stdout } = await execGh(["pr", "list"], { cwd: gh.dir });
        assert.equal(stdout.trim(), "ok pr list");

        // No gh anywhere on the PATH.
        const empty = join(gh.dir, "empty");
        mkdirSync(empty);
        const withGh = process.env.PATH;
        process.env.PATH = empty;
        try {
          const missing = await failureOf(execGhEffect(["pr", "list"]));
          assert.ok(
            missing instanceof GhSpawnError,
            `not a GhSpawnError: ${missing}`,
          );
          assert.equal(missing.code, "ENOENT");
          await assert.rejects(
            execGh(["pr", "list"]),
            (error) => error instanceof GhSpawnError && error.code === "ENOENT",
          );
        } finally {
          process.env.PATH = withGh;
        }
      },
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  done();
}

main().catch(fail);
