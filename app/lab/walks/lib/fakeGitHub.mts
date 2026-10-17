// A GitHub for walks: a repo whose origin is github.com over ssh,
// served from a bare repo beside it (core.sshCommand), and a gh that
// answers for one open pull request from a branch of it. What gh is
// asked beyond that is logged to `ghLog`, so a walk can say what the app
// wanted.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PR_NUMBER = 1;
const PR_URL = `https://github.com/o/r/pull/${PR_NUMBER}`;

export interface FakeGitHub {
  readonly ghScript: string;
  readonly ghLog: string;
  // Points the repo's origin at the stand-in.
  wire(repo: string, git: (cwd: string, ...args: string[]) => string): void;
  // Records the pull request gh describes: `head` into `base`. With
  // `unfetchableHead`, GitHub names a head commit no remote serves, as
  // for a network that can't reach it: the app falls back to `gh pr
  // diff`, which names blobs in short as GitHub's does.
  openPullRequest(
    git: (cwd: string, ...args: string[]) => string,
    options: {
      repo: string;
      head: string;
      base: string;
      title: string;
      unfetchableHead?: boolean;
    },
  ): void;
}

export function fakeGitHub(root: string): FakeGitHub {
  const remote = join(root, "github-remote.git");
  const ssh = join(root, "github-ssh");
  const state = join(root, "github-pr.json");
  const ghLog = join(root, "gh-calls.log");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\nexec sh -c "$(printf '%s' "$last" | sed "s|'o/r.git'|'${remote}'|")"\n`,
    { mode: 0o755 },
  );
  const ghScript = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const said = args.join(" ");
const pr = fs.existsSync(${JSON.stringify(state)})
  ? JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"))
  : null;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "auth") process.exit(0);
// The repo's description, which the project row reads.
if (args[0] === "api" && args[1] === "repos/o/r") process.exit(0);
// The branch's reviews: none.
if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.startsWith("head="))) {
  out({ data: { repository: { pullRequests: { nodes: [] } } } });
  process.exit(0);
}
// The repo's merge methods.
if (args[0] === "api" && args[1] === "graphql" && said.includes("mergeCommitAllowed")) {
  out({ data: { repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: false } } });
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  const head = args.includes("--head") ? args[args.indexOf("--head") + 1] : null;
  out(pr && (head === null || head === pr.headRefName) ? [pr] : []);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "diff" && pr?.diffRange && String(args[2]) === String(pr.number)) {
  process.stdout.write(
    require("node:child_process").execFileSync("git", ["diff", ...pr.diffRange], { encoding: "utf8" }),
  );
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view" && pr && String(args[2]) === String(pr.number)) {
  out(pr);
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(ghLog)}, said + "\\n");
process.stderr.write("unexpected gh " + said + "\\n");
process.exit(1);
`;
  return {
    ghScript,
    ghLog,
    wire(repo, git) {
      git(root, "init", "-q", "--bare", remote);
      git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
      git(repo, "config", "core.sshCommand", ssh);
      git(repo, "remote", "remove", "origin");
      git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
      git(repo, "push", "-q", "origin", "--all");
      git(repo, "fetch", "-q", "origin");
      git(repo, "branch", "-q", "-u", "origin/main", "main");
    },
    openPullRequest(git, { repo, head, base, title, unfetchableHead }) {
      const oid = (ref: string) => git(repo, "rev-parse", ref).trim();
      writeFileSync(
        state,
        JSON.stringify({
          number: PR_NUMBER,
          url: PR_URL,
          title,
          body: "",
          state: "OPEN",
          isDraft: false,
          isCrossRepository: false,
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          autoMergeRequest: null,
          baseRefName: base,
          headRefName: head,
          baseRefOid: oid(base),
          headRefOid: unfetchableHead ? "f".repeat(40) : oid(head),
          ...(unfetchableHead && { diffRange: [oid(base), oid(head)] }),
          author: { login: "walk" },
          updatedAt: "2026-10-10T10:00:00Z",
          createdAt: "2026-10-10T10:00:00Z",
          additions: 1,
          deletions: 0,
          changedFiles: 3,
          statusCheckRollup: [],
          reviewDecision: "",
          reviewRequests: [],
          latestReviews: [],
          labels: [],
          assignees: [],
        }),
      );
    },
  };
}
