// Durable proof for the commit-list parser (parseLog in
// host/lib/git/worktrees.ts), which turns `git log` output into the
// rows of a worktree's history.
//
// Asserts: the format and every case in shared/fixtures/git-log.json
// match, and a subject carrying the record sentinel, committed in a
// real repo, stays one commit. The CLI's go test holds its own parser
// to the same fixture.
//
// Run: pnpm test git-log.
//
// covers: app/shared/fixtures/git-log.json
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_FORMAT, listCommits, parseLog } from "@host/lib/git/worktrees";
import type { CommitSummary } from "@shared/schemas";
import { appRoot, makeProof, scrubProcessGitEnv } from "./lib/checkKit.mts";

const proof = makeProof("git-log proof");
console.log("git-log proof\n");

const fixture: {
  format: string;
  cases: { name: string; stdout: string; commits: CommitSummary[] }[];
} = JSON.parse(
  readFileSync(join(appRoot, "shared", "fixtures", "git-log.json"), "utf8"),
);

// listCommits runs git in this process, so the fixture repo's identity
// and the cut-off user config go on process.env.
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});

const repo = mkdtempSync(join(tmpdir(), "git-log-"));
try {
  await proof.check("the format is the fixture's", () => {
    assert.equal(LOG_FORMAT, fixture.format);
    assert.ok(fixture.cases.length > 0, "the fixture has cases");
  });
  for (const { name, stdout, commits } of fixture.cases) {
    // oxlint-disable-next-line no-await-in-loop -- one ok line per case, in order
    await proof.check(name, () => {
      assert.deepEqual(parseLog(stdout), commits);
    });
  }
  await proof.check(
    "a crafted subject in a real repo stays one commit",
    async () => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, env: process.env });
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "first");
      const crafted = "evil\x01NOTAHASH\tx\ty\tinjected";
      git("commit", "-q", "--allow-empty", "-m", crafted);
      const commits = await listCommits(repo, { skip: 0, count: 10 });
      assert.deepEqual(
        commits.map((c) => c.subject),
        [crafted, "first"],
      );
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
} finally {
  rmSync(repo, { recursive: true, force: true });
}
