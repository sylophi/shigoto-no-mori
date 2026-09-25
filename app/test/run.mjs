// The one entry point for the proofs in this directory:
//
//   pnpm test                  list them
//   pnpm test socket-host      run test/socket-host.mjs
//   pnpm test mirror account   run several, in order, stopping at a failure
//   pnpm test e2e/remote-smoke a path under test/ works too
//   pnpm test socket-host --update   flags pass through to the proof
//
// Each proof is a standalone script that exits non-zero when it fails.
// This runner only supplies what they all need from node: the ts-alias
// loader (lib/register-ts-alias.mjs), so they can import the app's
// TypeScript through its path aliases, and quiet type-stripping
// warnings. lefthook.yml calls it per job, gated to the files each
// proof covers. `lefthook run pre-commit --all-files` runs the lot.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const SELF = "run.mjs";

const SUFFIXES = [".mjs", ".mts"];

// The proofs, which sit at the top of test/. The drivers under e2e/ run
// by path (`pnpm test e2e/remote-smoke`) and stay off this list: they
// need two signed-in dev apps, see MANUAL-TESTING.md.
function available() {
  return readdirSync(testDir)
    .filter((file) => file !== SELF)
    .flatMap((file) =>
      SUFFIXES.filter((suffix) => file.endsWith(suffix)).map((suffix) =>
        file.slice(0, -suffix.length),
      ),
    )
    .toSorted();
}

function resolveTest(name) {
  for (const suffix of SUFFIXES) {
    const file = join(testDir, name + suffix);
    if (name + suffix !== SELF && existsSync(file)) return file;
  }
  return null;
}

// Arguments that start with a dash go to the tests themselves
// (`pnpm test socket-host --update`).
const args = process.argv.slice(2);
const names = args.filter((arg) => !arg.startsWith("-"));
const flags = args.filter((arg) => arg.startsWith("-"));
if (names.length === 0) {
  console.log("usage: pnpm test <name>...\n");
  for (const name of available()) console.log(`  ${name}`);
  process.exit(0);
}

for (const name of names) {
  const file = resolveTest(name);
  if (file === null) {
    console.error(`no such test: ${name} (run \`pnpm test\` for the list)`);
    process.exit(2);
  }
  const { status } = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      pathToFileURL(join(testDir, "lib", "register-ts-alias.mjs")).href,
      file,
      ...flags,
    ],
    { stdio: "inherit" },
  );
  if (status !== 0) process.exit(status ?? 1);
}
