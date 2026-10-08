// Durable proof that a branch's PR is never a stranger's fork PR. gh's
// --head filter and the project-wide listing both match a branch name
// across every fork, so a stranger's fork PR of the same name sits
// beside the branch's own, and the worktree page merges and drafts by
// whatever number these reads hand it. The host's single-branch read
// (getWorktreePullRequest) and the sidebar's map
// (refreshProjectPullRequests) skip fork PRs, and a branch with only a
// fork's reads as having none. The fork's PR a branch was checked out
// from (branch.<b>.merge at refs/pull/<n>/head) is the branch's own,
// and marked so. The renderer drops what a peer's host on an older
// build still answers with (ownBranchPullRequest and
// ownBranchPullRequests).
//
// Drives the real host code against a fake gh on PATH, which answers
// a --limit 1 lookup with the newest PR alone, as GitHub does, and a
// repo whose remote is on github.com.
//
// Run: pnpm test fork-pull-requests.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ownBranchPullRequest, ownBranchPullRequests } from "@/lib/pullRequest";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import {
  getWorktreePullRequest,
  refreshProjectPullRequests,
} from "@host/lib/githubCli/pullRequests";
import { it } from "vitest";
import {
  cliFailureMessage,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { processesLayer, trackTest, withLayer } from "./lib/vitestKit.mts";

scrubProcessGitEnv();

const row = (
  number: number,
  headRefName: string,
  isCrossRepository: boolean,
) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  body: "",
  state: "OPEN",
  isDraft: false,
  headRefName,
  baseRefName: "main",
  isCrossRepository,
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  author: { login: isCrossRepository ? "stranger" : "me" },
  updatedAt: "2026-10-01T00:00:00Z",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  statusCheckRollup: [],
});

// Newest first, as gh lists them. fox has its own #5 and a stranger's
// newer fork #9. lone has only a fork's #11. contrib was checked out
// from a fork's #42, beside a stranger's newer fork #13. docs has its
// own #7, and a fork's newer #44 of the same name was checked out as
// alice-docs (docs was taken), which keeps it off docs.
const fork9 = row(9, "fox", true);
const own5 = row(5, "fox", false);
const fork11 = row(11, "lone", true);
const fork13 = row(13, "contrib", true);
const fork42 = row(42, "contrib", true);
const fork44 = row(44, "docs", true);
const own7 = row(7, "docs", false);
const json = (rows: object[]) => `'${JSON.stringify(rows)}'`;

const GH = `#!/bin/sh
case "$*" in
  "auth status") ;;
  "api graphql "*) echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}';;
  "pr list --state all --head fox --limit 1 "*) echo ${json([fork9])};;
  "pr list --state all --head fox "*) echo ${json([fork9, own5])};;
  "pr list --state all --head lone "*) echo ${json([fork11])};;
  "pr list --state all --head contrib "*) echo ${json([fork13, fork42])};;
  "pr list --state all --head docs "*) echo ${json([fork44, own7])};;
  "pr list --state all --limit "*) echo ${json([fork44, fork13, fork9, fork42, fork11, own7, own5])};;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`;

withLayer(processesLayer);

it("the host's reads skip a fork's PR of the same name", async () => {
  const root = tempDir("sm-fork-prs-", trackTest);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH);
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env["PATH"];
  const ghConfig = process.env["GH_CONFIG_DIR"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  process.env["GH_CONFIG_DIR"] = join(root, "gh-config");
  trackTest(() => {
    process.env["PATH"] = path;
    if (ghConfig === undefined) delete process.env["GH_CONFIG_DIR"];
    else process.env["GH_CONFIG_DIR"] = ghConfig;
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
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  // What the app's PR checkout writes (pullRequestCheckout.ts).
  git(repo, "config", "branch.contrib.remote", "origin");
  git(repo, "config", "branch.contrib.merge", "refs/pull/42/head");
  git(repo, "config", "branch.alice-docs.remote", "origin");
  git(repo, "config", "branch.alice-docs.merge", "refs/pull/44/head");

  const fox = await getWorktreePullRequest(repo, "fox");
  assert.equal(fox?.number, 5, "the branch's own PR, not the fork's #9");
  assert.equal(
    await getWorktreePullRequest(repo, "lone"),
    null,
    "a branch with only a fork's PR has none",
  );

  const contrib = await getWorktreePullRequest(repo, "contrib");
  assert.equal(contrib?.number, 42, "the PR contrib was checked out from");
  assert.equal(contrib.checkedOutFrom, true);
  assert.equal(
    (await getWorktreePullRequest(repo, "docs"))?.number,
    7,
    "docs keeps its own PR, not the one alice-docs was checked out from",
  );

  const map = await refreshProjectPullRequests(repo);
  assert.equal(map.get("fox")?.number, 5);
  assert.equal(map.has("lone"), false, "lone has no PR of its own");
  assert.equal(map.get("contrib")?.number, 42);
  assert.equal(map.get("contrib")?.checkedOutFrom, true);
  assert.equal(map.get("docs")?.number, 7);
  assert.equal(map.get("fox")?.checkedOutFrom, undefined);

  // The renderer keeps what this host answers, and drops a
  // stranger's fork PR an older host still answers with.
  assert.ok(fox);
  assert.equal(ownBranchPullRequest(fox), fox);
  assert.equal(ownBranchPullRequest(contrib), contrib);
  assert.equal(
    ownBranchPullRequest({ ...fox, number: 9, isCrossRepository: true }),
    null,
  );
  assert.equal(ownBranchPullRequest(null), null);
  const prs = Object.fromEntries(map);
  assert.deepEqual(ownBranchPullRequests(prs), prs);
  const ownFox = map.get("fox");
  assert.ok(ownFox);
  const older = {
    ...prs,
    lone: { ...ownFox, number: 11, isCrossRepository: true },
  };
  assert.deepEqual(ownBranchPullRequests(older), prs);
});
