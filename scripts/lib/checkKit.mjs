// Shared plumbing for the repo's check scripts. Scripts collect their
// own failure strings and hand them to `report` for the one epilogue
// shape every check prints.
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

// The async sibling of makeChecker, for the e2e proof scripts: named
// scenario groups that drive real transports sequentially, where the
// first failure aborts the run. `name` is the proof phrase the summary
// lines print, like "sync-transfer proof".
//
//   - check(label, fn) awaits fn(track) and prints the "  ok" line.
//     track(cleanup) registers teardown that runs in reverse order even
//     when the assertions throw, so a failed check cannot leak the
//     event loop, and a cleanup failure never masks the test outcome.
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
    const cleanups = [];
    const track = (cleanup) => {
      cleanups.push(cleanup);
      return cleanup;
    };
    try {
      await fn(track);
    } finally {
      for (const cleanup of cleanups.toReversed()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- cleanups run serially by design
          await cleanup();
        } catch {
          // A cleanup failure must not mask the test outcome.
        }
      }
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
