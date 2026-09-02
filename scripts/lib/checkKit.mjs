// Shared plumbing for the repo's check scripts. Scripts collect their
// own failure strings and hand them to `report` for the one epilogue
// shape every check prints.
import { createServer } from "node:net";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, resolved from this file's location under scripts/lib/.
export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

// Strips block and line comments so prose can't trip source scans.
// Regex based, so a comment marker inside a string literal (a URL, a
// glob) mangles that string. Fine for presence checks, wrong for
// anything that needs faithful source.
export function stripComments(src) {
  return src.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

// Recursively yields every file under `dir` whose name matches the
// `extensions` regex.
export function* walk(dir, extensions) {
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile() && extensions.test(entry.name)) {
      yield join(entry.parentPath, entry.name);
    }
  }
}

// The failure-collecting harness every check script hand-rolls: a
// `failures` list and a `check(label, fn)` that runs one assertion group
// and records its message instead of throwing, so one failing group does
// not hide the rest. Returns both so the script can hand `failures` to
// `report` below. Synchronous, matching the assertion callbacks that use
// it.
// A loopback port number nothing holds right now: bind an ephemeral
// listener and release it. Free the instant the close lands, and
// nothing else grabs an ephemeral port in the same tick.
export function freeLoopbackPort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export function makeChecker() {
  const failures = [];
  function check(label, fn) {
    try {
      fn();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  return { check, failures };
}

// Teardown bookkeeping for fixture-heavy checks: register teardowns in
// creation order, run them in reverse, and keep going past a failing
// one so an assertion failure mid-scenario still releases every
// listener and socket instead of hanging the process (a cleanup
// failure never masks the test outcome). Used standalone by the checks
// whose scenarios share long-lived fixtures, and by makeProof's
// per-check cleanup below.
export function makeTracker() {
  const teardowns = [];
  return {
    track: (fn) => {
      teardowns.push(fn);
      return fn;
    },
    async teardown() {
      for (const fn of teardowns.toReversed()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- teardown is ordered
          await fn();
        } catch {
          // One failing teardown must not strand the rest.
        }
      }
    },
  };
}

// The async sibling of makeChecker, for the e2e proof scripts: named
// scenario groups that drive real transports sequentially, where the
// first failure aborts the run. `name` is the proof phrase the summary
// lines print, like "sync-transfer proof".
//
//   - check(label, fn) awaits fn(track) and prints the "  ok" line.
//     track(cleanup) registers teardown on a per-check makeTracker, so
//     cleanups run in reverse order even when the assertions throw and
//     a failed check cannot leak the event loop.
//   - ok(label) records an assertion group the script ran inline, for
//     proofs whose scenarios share long-lived fixtures instead of
//     per-check setup.
//   - done() prints the "<name> OK (N assertions)" summary.
//   - fail(error) prints the FAILED epilogue and sets a nonzero exit
//     code, shaped for main().catch(fail).
export function makeProof(name) {
  const passed = [];
  function ok(label) {
    passed.push(label);
    console.log(`  ok  ${label}`);
  }
  async function check(label, fn) {
    const { track, teardown } = makeTracker();
    try {
      await fn(track);
    } finally {
      await teardown();
    }
    ok(label);
  }
  return {
    check,
    ok,
    done: () => {
      console.log(`\n${name} OK (${passed.length} assertions)`);
    },
    fail: (error) => {
      console.error(`\n${name} FAILED: ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  };
}

// A controllable SupervisorClock (shared/remote/supervisor.ts) for
// checks that drive supervised runners headlessly: timers fire when
// advance crosses them, and a settle tick lets promise chains complete
// before assertions.
export function fakeClock() {
  let time = 0;
  let nextTimerId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      time += ms;
      // Deleting the visited entry is safe under Map iteration.
      for (const [id, timer] of timers) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

// `name` is the lowercase check phrase, like "host boundary". Failures
// print a capitalized header, each failure line, and the hint, then set
// a nonzero exit code. Setting exitCode instead of calling
// process.exit lets stderr flush when piped. Success prints "<name> OK".
export function report({ name, failures, hint }) {
  if (failures.length > 0) {
    console.error(`${name[0].toUpperCase()}${name.slice(1)} check failed:\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n${hint}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${name} OK`);
}

// A fake Clerk session JWT whose payload carries the given sub,
// unsigned on purpose: deriveAccountId (shared/account/token.ts) never
// verifies, it only reads the account id. The device hub is the sole
// verifier. Shared by the account and web-bridge checks so the one
// stub token shape cannot drift between them.
const jwtSegment = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");

export function fakeSessionJwt(sub) {
  return `${jwtSegment({ alg: "none", typ: "JWT" })}.${jwtSegment({ sub })}.sig`;
}
