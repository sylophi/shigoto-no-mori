// Durable proof that a pull request's diff page shows its media: the
// PR's diff is git's, from the two commits GitHub has on record for it
// (gh pr view's baseRefOid and headRefOid), with every blob id in full,
// so each side of an image reads back (readGitBlob), where gh pr diff's
// abbreviated ids read as "Can't show this file here.". Commits that
// aren't here, a PR pushed from another device, are fetched by hash
// from the PR's remote first, into no ref. gh pr diff answers only when
// they can't be fetched or git can't diff them here, and its too_large
// then says so.
//
// The PR is made the way the create dialog makes it (createPullRequest,
// which pushes the branch), from a branch that adds, changes and
// deletes images beside a text file, an SVG and a binary that is not an
// image. Drives the real host code against a fake gh on PATH and a repo
// whose remote is on github.com over ssh, which core.sshCommand serves
// from a bare repo beside it (the URL `git remote -v` prints, which the
// fetch's remote is matched by, stays github.com's). Run:
// pnpm test pull-request-diff.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { ReadBlobPayloadSchema } from "@shigomori/contracts/schemas";
import { isMediaBinary } from "@shigomori/ui/lib/patchFiles.ts";
import * as Schema from "effect/Schema";
import { getPullRequestDiff as getPullRequestDiffEffect } from "@host/lib/githubCli/actions";
import * as NewPullRequest from "@host/lib/githubCli/newPullRequest";
import { readGitBlob as readGitBlobEffect } from "@host/lib/worktrees/files";
import { afterAll, beforeAll, it } from "vitest";
import { runHost } from "./lib/hostRuntime.mts";
import { hostEngine } from "./lib/smBinary.mts";
import {
  installFakeGh,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const getPullRequestDiff = (cwd: string, number: number) =>
  runHost(getPullRequestDiffEffect({ cwd, number }));
const readGitBlob = (cwd: string, oid: string, path: string) =>
  runHost(readGitBlobEffect(cwd, oid, path));
const createPullRequest = (cwd: string) =>
  runHost(
    NewPullRequest.createPullRequest({
      cwd,
      projectPath: cwd,
      base: "main",
      title: "Images",
      body: "",
      draft: false,
      reviewers: [],
      assignees: [],
      labels: [],
      attachments: [],
    }),
  );

const PR_URL = "https://github.com/o/r/pull/1";
const GH_DIFF = "diff --git a/from-gh b/from-gh\n";

// Bytes git calls binary, which is all a diff sees, under each name.
const png = (...bytes: number[]) =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, ...bytes]);
const jpg = (...bytes: number[]) =>
  Buffer.from([0xff, 0xd8, 0xff, 0, ...bytes]);
const BASE = {
  "README.md": "one\n",
  "keep.png": png(1),
  "gone.png": png(2),
  "photo.jpg": jpg(3),
  "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>\n`,
  "blob.bin": Buffer.from([0, 1, 2]),
};
const BRANCH = {
  "README.md": "one\ntwo\n",
  "keep.png": png(4, 5),
  "new.png": png(6),
  "photo.jpg": jpg(7, 8),
  "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><rect width="8"/></svg>\n`,
  "blob.bin": Buffer.from([0, 3, 4]),
};

// gh's answers: the PR's commits, its diff by `diff` (ok, or GitHub's
// too_large refusal), and the create.
const gh = (dir: string) => `#!/bin/sh
dir='${dir}'
case "$*" in
  "auth token"*) ;;
  "pr list "*) echo '[]';;
  "pr create "*) echo '${PR_URL}';;
  "pr view 1 --json url,baseRefOid,headRefOid") cat "$dir/view.json";;
  "pr diff 1") echo call >> "$dir/diff-calls"
    case "$(cat "$dir/diff")" in
      ok) printf '${GH_DIFF}';;
      too_large) echo 'HTTP 406: Sorry, the diff exceeded the maximum number of files (300). (too_large)' >&2; exit 1;;
    esac;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`;

// ssh to github.com, answered by the bare repo: the last argument is
// the git command, naming the repo as 'o/r.git'.
const ssh = (remote: string) => `#!/bin/sh
for last; do :; done
exec sh -c "$(printf '%s' "$last" | sed "s|'o/r.git'|'${remote}'|")"
`;

function setup() {
  const root = tempDir("sm-pr-diff-", trackTest);
  installFakeGh(root, gh(root), trackTest);
  writeFileSync(join(root, "diff"), "ok");
  const git = sandboxGit();
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  // GitHub serves a commit by its hash.
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(root, "ssh"), ssh(remote), { mode: 0o755 });
  const clone = (name: string) => {
    const repo = join(root, name);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.sshCommand", join(root, "ssh"));
    git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    return repo;
  };
  const commit = (
    repo: string,
    files: Record<string, string | Buffer>,
    gone: string[],
    message: string,
  ) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(repo, name), content);
    }
    if (gone.length > 0) git(repo, "rm", "-q", ...gone);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
  };
  const repo = clone("repo");
  commit(repo, BASE, [], "base");
  git(repo, "push", "-q", "-u", "origin", "main");
  // What gh pr view says of the PR whose head is `head`, on main.
  const viewPullRequest = (head: string) =>
    writeFileSync(
      join(root, "view.json"),
      JSON.stringify({
        url: PR_URL,
        baseRefOid: git(remote, "rev-parse", "main").trim(),
        headRefOid: head,
      }),
    );
  return { root, git, remote, repo, clone, commit, viewPullRequest };
}

// The blob read's contract, which refuses an abbreviated id.
const decodeBlobId = Schema.decodeUnknownSync(ReadBlobPayloadSchema.fields.oid);

// The files of a PR's patch by name, and each media side's bytes as
// readGitBlob hands them back, by the ids the patch names, each one the
// blob read takes.
async function readPatch(repo: string, patch: string) {
  const files = parsePatchFiles(patch).flatMap((p) => p.files);
  const sides = new Map<string, Buffer | null>();
  for (const file of files.filter(isMediaBinary)) {
    for (const [side, oid] of [
      ["old", file.prevObjectId],
      ["new", file.newObjectId],
    ] as const) {
      if (!oid || /^0+$/.test(oid)) continue;
      decodeBlobId(oid);
      const blob = await readGitBlob(repo, oid, file.name);
      sides.set(
        `${side} ${file.name}`,
        blob.kind === "media" ? Buffer.from(blob.base64, "base64") : null,
      );
    }
  }
  return {
    names: files.map((file) => `${file.type} ${file.name}`).toSorted(),
    sides,
  };
}

// Every side of every image, as the branch left them.
const IMAGE_SIDES = new Map([
  ["old keep.png", BASE["keep.png"]],
  ["new keep.png", BRANCH["keep.png"]],
  ["new new.png", BRANCH["new.png"]],
  ["old gone.png", BASE["gone.png"]],
  ["old photo.jpg", BASE["photo.jpg"]],
  ["new photo.jpg", BRANCH["photo.jpg"]],
]);

const CHANGED = [
  "change README.md",
  "change blob.bin",
  "change keep.png",
  "change logo.svg",
  "change photo.jpg",
  "deleted gone.png",
  "new new.png",
];

scrubProcessGitEnv();

let dataDir: string;
let closeEngine: () => Promise<void>;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sm-pr-diff-data-"));
  ({ close: closeEngine } = await hostEngine(dataDir));
});
afterAll(async () => {
  await closeEngine();
  rmSync(dataDir, { recursive: true, force: true });
});

it("a PR made here shows both sides of each image, from git, whatever the prefixes", async () => {
  const { root, git, repo, commit, viewPullRequest } = setup();
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "switch", "-q", "-c", "images");
  commit(repo, BRANCH, ["gone.png"], "Images");
  assert.equal((await createPullRequest(repo)).url, PR_URL);
  viewPullRequest(git(repo, "rev-parse", "HEAD").trim());

  const patch = await getPullRequestDiff(repo, 1);
  const { names, sides } = await readPatch(repo, patch);
  assert.deepEqual(names, CHANGED);
  assert.deepEqual(sides, IMAGE_SIDES, "every image side reads back");
  assert.match(patch, /^\+<svg xmlns="http:\/\/www.w3.org\/2000\/svg"><rect/m);
  assert.match(patch, /^Binary files a\/blob.bin and b\/blob.bin differ$/m);
  assert.ok(!existsSync(join(root, "diff-calls")), "gh pr diff is never asked");
});

it("a PR pushed from another device is fetched by hash, into no ref", async () => {
  const { git, repo, clone, commit, viewPullRequest } = setup();
  const other = clone("other");
  git(other, "pull", "-q", "origin", "main");
  git(other, "switch", "-q", "-c", "images");
  commit(other, BRANCH, ["gone.png"], "Images");
  git(other, "push", "-q", "origin", "images");
  // main moves on, and this device hasn't fetched it either.
  git(other, "switch", "-q", "main");
  commit(other, { "later.txt": "later\n" }, [], "later");
  git(other, "push", "-q", "origin", "main");
  const head = git(other, "rev-parse", "images").trim();
  viewPullRequest(head);
  const refs = git(repo, "for-each-ref");

  const { names, sides } = await readPatch(
    repo,
    await getPullRequestDiff(repo, 1),
  );
  assert.deepEqual(names, CHANGED, "main's later commit isn't the PR's");
  assert.deepEqual(sides, IMAGE_SIDES);
  assert.equal(git(repo, "cat-file", "-t", head).trim(), "commit");
  assert.equal(git(repo, "for-each-ref"), refs, "no ref made or moved");
});

it("gh pr diff answers when the commits can't be fetched or diffed here", async () => {
  const { root, git, repo, viewPullRequest } = setup();
  viewPullRequest("1".repeat(40));
  assert.equal(await getPullRequestDiff(repo, 1), GH_DIFF);

  writeFileSync(join(root, "diff"), "too_large");
  await assert.rejects(getPullRequestDiff(repo, 1), {
    message: `This pull request is too large for GitHub to diff, and its commits couldn't be fetched and diffed here.`,
  });

  writeFileSync(join(root, "diff"), "ok");
  git(repo, "switch", "-q", "--orphan", "unrelated");
  git(repo, "commit", "-q", "--allow-empty", "-m", "unrelated");
  viewPullRequest(git(repo, "rev-parse", "HEAD").trim());
  assert.equal(
    await getPullRequestDiff(repo, 1),
    GH_DIFF,
    "both commits here and no merge base, as in a shallow clone",
  );

  git(repo, "remote", "set-url", "origin", "git@github.com:o/elsewhere.git");
  assert.equal(
    await getPullRequestDiff(repo, 1),
    GH_DIFF,
    "no remote holds the PR",
  );
});
