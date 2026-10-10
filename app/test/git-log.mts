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
import * as Worktrees from "@host/lib/git/worktrees";
import { promised } from "./lib/gitPromises.mts";

const { LOG_FORMAT, listCommits, parseLog } = promised(Worktrees);
import type { CommitSummary } from "@shigomori/contracts/schemas";
import { afterAll, beforeAll, it } from "vitest";
import { appRoot, scrubProcessGitEnv } from "./lib/checkKit.mts";

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

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "git-log-"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

it("the format is the fixture's", () => {
  assert.equal(LOG_FORMAT, fixture.format);
  assert.ok(fixture.cases.length > 0, "the fixture has cases");
});
for (const { name, stdout, commits } of fixture.cases) {
  it(name, () => {
    assert.deepEqual(parseLog(stdout), commits);
  });
}
it("a crafted subject in a real repo stays one commit", async () => {
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
});

it("a search keeps the commits whose message holds it, literally and case blind", async () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env: process.env });
  git("commit", "-q", "--allow-empty", "-m", "Fix the [sidebar] badge");
  git(
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Unrelated\n\nTouches the sidebar too.",
  );
  const subjects = async (query: string) =>
    (await listCommits(repo, { skip: 0, count: 10, query })).map(
      (c) => c.subject,
    );
  assert.deepEqual(await subjects("SIDEBAR"), [
    "Unrelated",
    "Fix the [sidebar] badge",
  ]);
  assert.deepEqual(await subjects("[sidebar]"), ["Fix the [sidebar] badge"]);
  assert.deepEqual(await subjects("nowhere"), []);
});
