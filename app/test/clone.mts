// Durable proof for cloning a project onto a device (projects:clone):
// the payload schema's accept/reject table, which is what keeps a
// caller on another machine to real remotes and one folder segment, and
// cloneRepo against a REAL git repository for what the schema can't
// say: the checkout lands where asked, and neither an existing folder
// nor a missing parent is written over or conjured.
//
// Run: pnpm test clone.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { sandboxGit, scrubbedGitEnv } from "./lib/checkKit.mts";
import { scrubProcessGitEnv, tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

// cloneRepo runs git under this process's environment. The pre-commit
// hook's GIT_* variables would point that git at the commit in
// progress, so they go before anything is imported.
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv();

const { cloneRepo } = await import("../host/lib/git/clone.ts");
const { githubHostOf } = await import("../host/lib/githubCli/GithubCli.ts");
const { cloneUrlOf } =
  await import("@shigomori/contracts/predicates/remoteUrl");
const { cloneFolderName, pickCloneUrl, repoNameFromUrl, stripUrlCredentials } =
  await import("../shared/cloneUrl.ts");
const { CloneProjectPayloadSchema } =
  await import("@shigomori/contracts/schemas/project");

const git = sandboxGit(gitEnv);

const accepts = (input: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(CloneProjectPayloadSchema)(input));

it("a remote URL in any of git's syntaxes is accepted", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "github.com:owner/repo",
    "  git@github.com:owner/repo.git  ",
  ]) {
    assert.ok(accepts({ url, parentDir: "~/dev" }), url);
  }
});

it("a path, a file:// URL and an option-shaped string are refused", () => {
  for (const url of [
    "/Users/someone/dev/repo",
    "~/dev/repo",
    "../repo",
    "file:///Users/someone/dev/repo",
    "--upload-pack=touch /tmp/pwned",
    "-u",
    "",
    "repo",
    "-o/repo",
    "owner/..",
    "owner/repo/extra",
    "../repo",
  ]) {
    assert.ok(!accepts({ url, parentDir: "~/dev" }), url);
  }
});

it("a GitHub owner/repo is accepted, and names the repo's https URL", () => {
  for (const url of [
    "owner/repo",
    "my-org/repo.v2",
    "owner/.github",
    "alice_acme/tools",
  ]) {
    assert.ok(accepts({ url, parentDir: "~/dev" }), url);
  }
  assert.equal(cloneUrlOf(" owner/repo "), "https://github.com/owner/repo");
  assert.equal(cloneUrlOf("/srv/repo"), "/srv/repo");
  assert.equal(cloneFolderName("owner/repo"), "repo");
  assert.equal(cloneFolderName("owner/repo.git"), "repo");
  assert.equal(cloneFolderName("git@github.com:owner/repo.git"), "repo");
});

it("a GitHub remote is told from the rest", async () => {
  const urls = [
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@ssh.github.com:443/owner/repo",
    "https://gitlab.com/owner/repo.git",
    "/srv/owner/repo",
  ];
  const hosts = await Promise.all(urls.map(githubHostOf));
  assert.deepEqual(hosts, [
    "github.com",
    "github.com",
    "github.com",
    null,
    null,
  ]);
});

it("the folder name is held to one path segment", () => {
  const url = "git@github.com:owner/repo.git";
  for (const name of ["repo", "my repo", "repo.v2"]) {
    assert.ok(accepts({ url, parentDir: "~/dev", name }), name);
  }
  for (const name of ["", ".", "..", "a/b", "../escape", "a\\b"]) {
    assert.ok(!accepts({ url, parentDir: "~/dev", name }), name);
  }
});

it("the default folder is the repo's own name", () => {
  assert.equal(repoNameFromUrl("git@github.com:owner/repo.git"), "repo");
  assert.equal(repoNameFromUrl("https://github.com/owner/repo/"), "repo");
  assert.equal(repoNameFromUrl("https://gitlab.com/a/b/c.git"), "c");
  assert.equal(repoNameFromUrl("/some/path"), null);
  assert.equal(repoNameFromUrl("--flag"), null);
});

it("the URL handed to another device: origin first, remotes only, never a credential", () => {
  const ssh = "git@github.com:owner/repo.git";
  assert.equal(
    pickCloneUrl([
      { name: "upstream", url: "https://github.com/up/repo.git" },
      { name: "origin", url: ssh },
    ]),
    ssh,
  );
  assert.equal(
    pickCloneUrl([
      { name: "zeta", url: "https://example.com/z/repo" },
      { name: "alpha", url: "https://example.com/a/repo" },
    ]),
    "https://example.com/a/repo",
  );
  // A path-style origin names this machine's disk: skipped.
  assert.equal(
    pickCloneUrl([
      { name: "origin", url: "/srv/git/repo.git" },
      { name: "backup", url: "file:///srv/git/repo.git" },
    ]),
    null,
  );
  assert.equal(pickCloneUrl([]), null);
  for (const [url, want] of [
    ["https://ghp_secret@github.com/o/r.git", "https://github.com/o/r.git"],
    ["https://user:p@ss@github.com/o/r", "https://github.com/o/r"],
    ["http://user:pw@host.test:8080/o/r", "http://host.test:8080/o/r"],
    ["https://github.com/o/r@v2", "https://github.com/o/r@v2"],
    [ssh, ssh],
    ["ssh://git@github.com/o/r.git", "ssh://git@github.com/o/r.git"],
  ] as const) {
    assert.equal(stripUrlCredentials(url), want, url);
  }
  assert.equal(
    pickCloneUrl([
      { name: "origin", url: "https://ghp_secret@github.com/o/r.git" },
    ]),
    "https://github.com/o/r.git",
  );
});

it("cloneRepo lands a real checkout where asked", async () => {
  const sandbox = tempDir("sm-clone-", trackTest);
  const source = join(sandbox, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "README.md"), "hello\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "init");
  const parent = join(sandbox, "parent");
  mkdirSync(parent);

  const dest = await cloneRepo(source, parent, "copy");
  assert.equal(dest, join(parent, "copy"));
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "hello\n");
  assert.equal(git(dest, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");

  // A second clone onto the same folder must not touch it.
  writeFileSync(join(dest, "local.txt"), "mine\n");
  await assert.rejects(cloneRepo(source, parent, "copy"), /already exists/);
  assert.ok(existsSync(join(dest, "local.txt")));

  // A parent that isn't there is refused, not created.
  const missing = join(sandbox, "nowhere");
  await assert.rejects(cloneRepo(source, missing, "copy"), /not a folder/);
  assert.ok(!existsSync(missing));

  // A remote that can't be reached fails and leaves nothing behind.
  await assert.rejects(
    cloneRepo(join(sandbox, "no-such-repo"), parent, "ghost"),
  );
  assert.ok(!existsSync(join(parent, "ghost")));
});

it("a failed clone's message never carries the URL's credentials", async () => {
  const sandbox = tempDir("sm-clone-", trackTest);
  // Nothing listens on port 1, so this fails at once and offline,
  // with git naming the URL it could not reach.
  const failure = await cloneRepo(
    "https://someone:s3cret-t0ken@127.0.0.1:1/owner/repo.git",
    sandbox,
    "repo",
  ).then(
    () => null,
    (error) => error,
  );
  assert.ok(failure instanceof Error, "the clone did not fail");
  assert.ok(
    !failure.message.includes("s3cret-t0ken"),
    `the token is in the message: ${failure.message}`,
  );
  assert.ok(!existsSync(join(sandbox, "repo")));
});
