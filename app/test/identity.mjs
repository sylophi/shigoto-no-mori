// Fixture harness for the repo-identity algorithm
// (shared/git/repoIdentity.mts): the URL normalization cases are pure.
// Repo scenarios are materialized as real git repos in a temp dir, with
// fixed dates/author and isolated git config so the `root:<sha>` values
// in the fixture file hold as literals. The CLI computes the same
// identity for the project rows the app reads (cli/repoidentity.go, the
// `identity` of `sm projects list`), while peers still run the
// TypeScript for each other's repos, so every scenario is also
// registered with the sm binary built from cli/ and its row held to
// the same literal: the two implementations cannot drift apart.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveDefaultRef } from "../shared/git/defaultBranch.mts";
import {
  computeRepoIdentity,
  normalizeRemoteUrl,
} from "../shared/git/repoIdentity.mts";
import { createCliRunner, report, scrubbedGitEnv } from "./lib/checkKit.mjs";
import { builtSm } from "./lib/smBinary.mjs";

const execFileP = promisify(execFile);
const root = join(import.meta.dirname, "..");
const fixtures = (name) =>
  JSON.parse(readFileSync(join(root, "shared/fixtures", name), "utf8"));

// git exports GIT_DIR / GIT_INDEX_FILE into hook processes, so a run
// from lefthook would otherwise build its fixture repos into THIS
// repo's git directory. Scrub every inherited GIT_* before spawning.
// The shared default-branch resolver takes this same runner, so its
// probes are scrubbed too (the app binds it to core.ts instead, which
// inherits process env).
const gitEnv = {
  ...scrubbedGitEnv(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2005-04-07T22:13:13+0000",
  GIT_COMMITTER_DATE: "2005-04-07T22:13:13+0000",
};

async function run(cwd, args) {
  const { stdout } = await execFileP("git", args, { cwd, env: gitEnv });
  return stdout;
}

const failures = [];
const show = (value) => (value === null ? "null" : `"${value}"`);

for (const { input, expected } of fixtures("repo-identity-urls.json")) {
  const got = normalizeRemoteUrl(input);
  if (got !== expected) {
    failures.push(
      `normalize "${input}": got ${show(got)}, want ${show(expected)}`,
    );
  }
}

// Each scenario owns its directory tree, so scenarios (and the checks
// within one) run concurrently. Only a scenario's repo-build steps are
// ordered. This runs on every pre-commit, and the git spawns dominate.
async function checkScenario(scenario, temp) {
  const scenarioRoot = join(temp, scenario.name.replace(/[^\w-]+/g, "-"));
  for (const repo of scenario.repos) {
    const dir = join(scenarioRoot, repo.dir);
    mkdirSync(dir, { recursive: true });
    for (const args of repo.git) {
      // oxlint-disable-next-line no-await-in-loop -- fixture steps are ordered
      await run(
        dir,
        args.map((a) => a.replaceAll("{{root}}", scenarioRoot)),
      );
    }
  }
  await Promise.all(
    scenario.checks.map(async ({ dir, expected }) => {
      cliChecks.push({
        label: `${scenario.name} [${dir}]`,
        path: join(scenarioRoot, dir),
        expected,
      });
      // Identity rejects on git failures (fixtures only pin values), so
      // an error is itself a failed check, not a crashed harness.
      let got;
      try {
        got = await computeRepoIdentity(join(scenarioRoot, dir), {
          run,
          resolveDefaultRef: (path) => resolveDefaultRef(run, path),
        });
      } catch (err) {
        failures.push(`${scenario.name} [${dir}]: identity errored: ${err}`);
        return;
      }
      if (got !== expected) {
        failures.push(
          `${scenario.name} [${dir}]: got ${show(got)}, want ${show(expected)}`,
        );
      }
    }),
  );
}

// Every scenario check, for the CLI pass below.
const cliChecks = [];

// The CLI's identity for each checked repo: registered into a sandbox
// data dir one by one (registration takes the registry lock anyway),
// then read back off one project list.
async function checkCliIdentities(temp) {
  const { sm } = createCliRunner(builtSm(), {
    ...gitEnv,
    SHIGOMORI_DATA_DIR: join(temp, "sm-data"),
  });
  for (const { label, path } of cliChecks) {
    // oxlint-disable-next-line no-await-in-loop -- one registry writer at a time
    await sm("projects", "add", "--", path).catch((err) => {
      failures.push(`${label}: sm projects add failed: ${err.message}`);
    });
  }
  const { docs } = await sm("projects", "list");
  const identityAt = new Map(docs[0].map((row) => [row.path, row.identity]));
  for (const { label, path, expected } of cliChecks) {
    if (!identityAt.has(path)) {
      failures.push(`${label}: the CLI lists no project at ${path}`);
      continue;
    }
    const got = identityAt.get(path);
    if (got !== expected) {
      failures.push(
        `${label}: the CLI got ${show(got)}, want ${show(expected)}`,
      );
    }
  }
}

// realpath: the CLI registers git's spelling of a path, which resolves
// the /var -> /private/var symlink the temp dir sits behind.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "sm-identity-")));
try {
  await Promise.all(
    fixtures("repo-identity-scenarios.json").map((scenario) =>
      checkScenario(scenario, temp),
    ),
  );
  await checkCliIdentities(temp);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

report({
  name: "repo identity",
  failures,
  hint: "Either fix shared/git/repoIdentity.mts or cli/repoidentity.go, or update the fixtures in shared/fixtures/.",
});
