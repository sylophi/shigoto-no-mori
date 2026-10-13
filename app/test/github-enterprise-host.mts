// Durable proof that a repo on a GitHub Enterprise host is read from
// that host, with github.com signed in beside it. `gh api` asks
// github.com unless GH_HOST says otherwise, so the repo's merge
// settings came back empty and the Git heading never offered a pull
// request. The host's gh runs in a repo are pinned to the host of the
// remote gh resolves it from (githubCli/exec.ts, GitHub.hostOf), so a
// mirror on github.com beside it changes nothing.
//
// Drives the real host code against a fake gh on PATH that answers the
// merge settings and About reads only when GH_HOST names the
// Enterprise host, as github.com would know no such repo. gh's config
// is set before the host's services start, since the engine reads the
// environment as the graph comes up.
//
// Run: pnpm test github-enterprise-host.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, it } from "vitest";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import { runHost } from "./lib/hostRuntime.mts";
import {
  installFakeGh,
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

const GH = `#!/bin/sh
case "$GH_HOST $*" in
  *" auth token"*) echo token;;
  "ghe.example.com api repos/o/r "*) echo "An Enterprise repo";;
  "ghe.example.com api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"autoMergeAllowed":true}}}';;
  *) echo "gh: Could not resolve to a Repository (HTTP 404)" >&2; exit 1;;
esac
`;

const tracker = makeTracker();
afterAll(() => tracker.teardown());
scrubProcessGitEnv();
const root = tempDir("sm-ghe-host-", tracker.track);
installFakeGh(root, GH, tracker.track);
mkdirSync(join(root, "gh-config"));
writeFileSync(
  join(root, "gh-config", "hosts.yml"),
  "github.com:\n    user: me\nghe.example.com:\n    user: me\n",
);
const ghHost = process.env["GH_HOST"];
delete process.env["GH_HOST"];
tracker.track(() => {
  if (ghHost !== undefined) process.env["GH_HOST"] = ghHost;
});

it("a repo on an Enterprise host is read from it", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = sandboxGit();
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "git@ghe.example.com:o/r.git");
  assert.equal(
    await runHost(Effect.flatMap(GithubCli, (cli) => cli.description(repo))),
    "An Enterprise repo",
  );

  // Listed first, but gh's own choice of remote is origin.
  git(repo, "remote", "add", "backup", "git@github.com:o/r.git");

  assert.deepEqual(
    await runHost(Effect.flatMap(GithubCli, (cli) => cli.mergeConfig(repo))),
    { merge: false, squash: true, rebase: false, autoMerge: true },
  );
});
