// Durable proof that a repo on a GitHub Enterprise host is read from
// that host, with github.com signed in beside it. `gh api` asks
// github.com unless GH_HOST says otherwise, so the repo's merge
// settings came back empty and the Git heading never offered a pull
// request. The host's gh runs in a repo are pinned to its remote's
// host (githubCli/exec.ts).
//
// Drives the real host code against a fake gh on PATH that answers the
// merge settings and About reads only when GH_HOST names the
// Enterprise host, as github.com would know no such repo. Runs under
// test/lib/register-ts-alias.mts. Run: pnpm test github-enterprise-host.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { getRepoMergeConfig } from "@host/lib/githubCli/repoConfig";
import { getRepoDescription } from "@host/lib/githubCli/repoDescription";
import {
  cliFailureMessage,
  makeProof,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

const proof = makeProof("github-enterprise-host proof");
console.log("github-enterprise-host proof\n");

const GH = `#!/bin/sh
case "$GH_HOST $*" in
  *" auth status") ;;
  "github.ubc.ca api repos/o/r "*) echo "A UBC repo";;
  "github.ubc.ca api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"autoMergeAllowed":true}}}';;
  *) echo "gh: Could not resolve to a Repository (HTTP 404)" >&2; exit 1;;
esac
`;

try {
  scrubProcessGitEnv();
  await proof.check(
    "a repo on an Enterprise host is read from it",
    async (track) => {
      const root = tempDir("sm-ghe-host-", track);
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "gh"), GH);
      chmodSync(join(bin, "gh"), 0o755);
      const ghConfig = join(root, "gh-config");
      mkdirSync(ghConfig);
      writeFileSync(
        join(ghConfig, "hosts.yml"),
        "github.com:\n    user: me\ngithub.ubc.ca:\n    user: me\n",
      );
      const saved = {
        PATH: process.env["PATH"],
        GH_CONFIG_DIR: process.env["GH_CONFIG_DIR"],
        GH_HOST: process.env["GH_HOST"],
      };
      process.env["PATH"] = `${bin}${delimiter}${saved.PATH ?? ""}`;
      process.env["GH_CONFIG_DIR"] = ghConfig;
      delete process.env["GH_HOST"];
      track(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      });
      // The integration toggle is read through `sm config read`.
      setCliRunnerImpl({
        runCli: () =>
          Promise.resolve({
            code: 0,
            docs: [{ ok: true, config: {} }],
            stderrTail: "",
          }),
        requireCliBinary: () => "sm",
        cliFailureMessage,
      });
      const repo = join(root, "repo");
      mkdirSync(repo);
      const git = sandboxGit();
      git(repo, "init", "-q");
      git(repo, "remote", "add", "origin", "git@github.ubc.ca:o/r.git");

      assert.deepEqual(await getRepoMergeConfig(repo), {
        merge: false,
        squash: true,
        rebase: false,
        autoMerge: true,
      });
      assert.equal(await getRepoDescription(repo), "A UBC repo");
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
}
