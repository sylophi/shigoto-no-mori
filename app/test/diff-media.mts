// Durable proof for a media file's sides in a diff
// (renderer/components/diff/MediaDiff.tsx) against a REAL repository:
// git's patch for an image parses into a file with no hunks that names
// both blobs, the way the diff page tells it apart, and readGitBlob
// (host/lib/worktrees/files.ts, over the engine's Git) hands back each
// side's bytes, the text a media extension can hold, and a blob the
// repository doesn't have as missing.
//
// Run: pnpm test diff-media.
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { only } from "@shigomori/contracts/util/only";
import { isMediaBinary } from "@shigomori/ui/lib/patchFiles.ts";
import { it } from "vitest";
import { readGitBlob as readGitBlobEffect } from "@host/lib/worktrees/files";
import {
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { GIT_IDENTITY } from "../../gitIsolation.ts";
import { engineGit, promised } from "./lib/gitPromises.mts";
import { trackTest } from "./lib/vitestKit.mts";

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv(GIT_IDENTITY);

const { readGitBlob } = promised({ readGitBlob: readGitBlobEffect });
const fileDiff = (worktree: string, paths: string[], untracked: boolean) =>
  engineGit.fileDiff({ worktree, paths, untracked });

const git = sandboxGit(gitEnv);

console.log("diff-media proof\n");

// Not a real PNG, but bytes git calls binary, which is all a diff sees.
const OLD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
const NEW = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 4, 5, 6, 7]);

// What readGitBlob answers for a PNG holding `bytes`.
const media = (bytes: Buffer) => ({
  kind: "media",
  mime: "image/png",
  base64: bytes.toString("base64"),
  size: bytes.length,
});

// A repository whose two commits add board.png, then change it.
function seedRepo(): { repo: string; head: string } {
  const repo = tempDir("sm-diff-media-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "board.png"), OLD);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "add");
  writeFileSync(join(repo, "board.png"), NEW);
  git(repo, "commit", "-q", "-am", "change");
  return { repo, head: git(repo, "rev-parse", "HEAD").trim() };
}

// The patch's one file, failing the check when it has another count.
function onlyFile(patch: string) {
  const file = only(parsePatchFiles(patch).flatMap((p) => p.files));
  assert.ok(file, `not one file in:\n${patch}`);
  return file;
}

it("an image's patch has no hunks and names both blobs, which read back", async () => {
  const { repo, head } = seedRepo();
  const file = onlyFile(await engineGit.commitDiff(repo, head));
  assert.equal(file.name, "board.png");
  assert.equal(file.type, "change");
  assert.ok(isMediaBinary(file));
  assert.ok(file.prevObjectId && file.newObjectId);
  const sides = await Promise.all(
    [file.prevObjectId, file.newObjectId].map((oid) =>
      readGitBlob(repo, oid, "board.png"),
    ),
  );
  assert.deepEqual(sides, [media(OLD), media(NEW)]);
});

// The patch of every diff page for board.png: the working tree's (an
// edit, and an untracked copy), a commit's, a branch's and a stash's.
async function everyPatch(repo: string, head: string) {
  const root = git(repo, "rev-list", "--max-parents=0", "HEAD").trim();
  writeFileSync(join(repo, "board.png"), OLD);
  const working = await fileDiff(repo, ["board.png"], false);
  writeFileSync(join(repo, "copy.png"), OLD);
  const untracked = await fileDiff(repo, ["copy.png"], true);
  git(repo, "stash", "-q");
  return {
    working,
    untracked,
    commit: await engineGit.commitDiff(repo, head),
    branch: await engineGit.mergeBaseDiff({ repo, base: root, head }),
    stash: await engineGit.readStashDiff(
      repo,
      git(repo, "rev-parse", "--short", "stash@{0}").trim(),
    ),
  };
}

// The blob read takes a full id only (ReadBlobPayloadSchema), so every
// patch a diff page reads names its blobs in full.
it("every diff page's patch names its blobs by full id", async () => {
  const { repo, head } = seedRepo();
  for (const [page, patch] of Object.entries(await everyPatch(repo, head))) {
    const file = onlyFile(patch);
    for (const oid of [file.prevObjectId, file.newObjectId]) {
      if (page === "untracked" && oid === file.prevObjectId) continue;
      assert.match(oid ?? "", /^[0-9a-f]{40}$/, page);
    }
  }
});

// The parser needs git's own patch: the a/ and b/ prefixes, and the
// change itself, not what an external diff or a textconv prints.
it("every diff page's patch is git's own, whatever the repo's diff config", async () => {
  const { repo, head } = seedRepo();
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "config", "diff.external", "echo");
  writeFileSync(join(repo, ".git", "info", "attributes"), "*.png diff=hex\n");
  git(repo, "config", "diff.hex.textconv", "od -c");
  for (const [page, patch] of Object.entries(await everyPatch(repo, head))) {
    const file = onlyFile(patch);
    assert.equal(
      file.name,
      page === "untracked" ? "copy.png" : "board.png",
      page,
    );
    assert.ok(isMediaBinary(file), `${page}: a binary patch naming its blobs`);
  }
});

it("an added image's patch is new, and so is an untracked one's", async () => {
  const { repo } = seedRepo();
  const root = git(repo, "rev-list", "--max-parents=0", "HEAD").trim();
  const added = onlyFile(await engineGit.commitDiff(repo, root));
  assert.equal(added.type, "new");
  assert.ok(isMediaBinary(added));
  writeFileSync(join(repo, "fresh.png"), NEW);
  const untracked = onlyFile(await fileDiff(repo, ["fresh.png"], true));
  assert.equal(untracked.name, "fresh.png");
  assert.equal(untracked.type, "new");
  assert.ok(isMediaBinary(untracked), "the preview needs the new side named");
});

it("a working-tree patch's new side reads off the disk while it still hashes the same", async () => {
  const { repo } = seedRepo();
  writeFileSync(join(repo, "board.png"), OLD);
  const edited = onlyFile(await fileDiff(repo, ["board.png"], false));
  assert.ok(edited.prevObjectId && edited.newObjectId);
  assert.deepEqual(
    await readGitBlob(repo, edited.newObjectId, "board.png"),
    media(OLD),
  );
  assert.deepEqual(
    await readGitBlob(repo, edited.prevObjectId, "board.png"),
    media(NEW),
  );
  // Bytes no commit holds, so only the disk has them.
  const fresh = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 8]);
  writeFileSync(join(repo, "fresh.png"), fresh);
  const untracked = onlyFile(await fileDiff(repo, ["fresh.png"], true));
  assert.ok(untracked.newObjectId);
  assert.deepEqual(
    await readGitBlob(repo, untracked.newObjectId, "fresh.png"),
    media(fresh),
  );
  // Saved again since the patch was read.
  writeFileSync(join(repo, "fresh.png"), OLD);
  assert.deepEqual(
    await readGitBlob(repo, untracked.newObjectId, "fresh.png"),
    { kind: "missing" },
  );
  // An ignored file stays out, even asked for by its own id.
  writeFileSync(join(repo, ".gitignore"), "*.secret.png\n");
  writeFileSync(join(repo, "key.secret.png"), fresh);
  const ignored = git(repo, "hash-object", "key.secret.png").trim();
  assert.deepEqual(await readGitBlob(repo, ignored, "key.secret.png"), {
    kind: "missing",
  });
  // Nor does a short id, a guess away from any file.
  assert.deepEqual(
    await readGitBlob(repo, untracked.newObjectId.slice(0, 7), "fresh.png"),
    { kind: "missing" },
  );
  // A symlink shows where it points in a diff, never what is there.
  symlinkSync("key.secret.png", join(repo, "link.png"));
  assert.deepEqual(await readGitBlob(repo, ignored, "link.png"), {
    kind: "missing",
  });
});

it("a pure rename names no blobs, so it gets no preview", async () => {
  const { repo } = seedRepo();
  git(repo, "mv", "board.png", "moved.png");
  const renamed = onlyFile(
    await fileDiff(repo, ["board.png", "moved.png"], false),
  );
  assert.equal(renamed.type, "rename-pure");
  assert.ok(!isMediaBinary(renamed));
});

it("a blob with a media name reads as text when it is text, and an unknown one as missing", async () => {
  const { repo } = seedRepo();
  const pointer = "version https://git-lfs.github.com/spec/v1\n";
  writeFileSync(join(repo, "pointer.png"), pointer);
  const oid = git(repo, "hash-object", "-w", "pointer.png").trim();
  assert.deepEqual(await readGitBlob(repo, oid, "pointer.png"), {
    kind: "text",
    contents: pointer,
    size: pointer.length,
  });
  assert.deepEqual(await readGitBlob(repo, "deadbeef", "board.png"), {
    kind: "missing",
  });
  // A commit's id names an object, but not a blob.
  const head = git(repo, "rev-parse", "HEAD").trim();
  assert.deepEqual(await readGitBlob(repo, head, "board.png"), {
    kind: "missing",
  });
});
