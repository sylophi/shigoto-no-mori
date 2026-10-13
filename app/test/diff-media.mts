// Durable proof for a media file's two sides in a diff
// (renderer/components/diff/MediaDiff.tsx) against a REAL repository:
// git's patch for an image parses into a file with no hunks that names
// both blobs, the way the diff view tells it apart, and readGitBlob
// (host/lib/worktrees/files.ts) hands back each side's bytes, the text
// a media extension can hold, and a blob the repository doesn't have
// as missing.
//
// Runs under test/lib/register-ts-alias.mts so the app's TypeScript
// imports resolve. Run: pnpm test diff-media.
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { mediaTypeOf } from "@shared/mediaTypes";
import { only } from "@shared/util/only";
import {
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
  type Track,
} from "./lib/checkKit.mts";

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

const { getCommitDiff, getFileDiff } = await import("../host/lib/git/diff.ts");
const { readGitBlob } = await import("../host/lib/worktrees/files.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("diff-media proof");
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
function seedRepo(track: Track): { repo: string; head: string } {
  const repo = tempDir("sm-diff-media-", track);
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

async function main() {
  await check(
    "an image's patch has no hunks and names both blobs, which read back",
    async (track) => {
      const { repo, head } = seedRepo(track);
      const file = onlyFile(await getCommitDiff(repo, head));
      assert.equal(file.name, "board.png");
      assert.equal(file.type, "change");
      assert.equal(file.hunks.length, 0);
      assert.ok(file.prevObjectId && file.newObjectId);
      const sides = await Promise.all(
        [file.prevObjectId, file.newObjectId].map((oid) =>
          readGitBlob(repo, oid, "board.png"),
        ),
      );
      assert.deepEqual(sides, [media(OLD), media(NEW)]);
    },
  );

  await check(
    "an added image's patch is new, and so is an untracked one's",
    async (track) => {
      const { repo } = seedRepo(track);
      const root = git(repo, "rev-list", "--max-parents=0", "HEAD").trim();
      const added = onlyFile(await getCommitDiff(repo, root));
      assert.equal(added.type, "new");
      assert.equal(added.hunks.length, 0);
      writeFileSync(join(repo, "fresh.png"), NEW);
      const untracked = onlyFile(await getFileDiff(repo, ["fresh.png"], true));
      assert.equal(untracked.name, "fresh.png");
      assert.equal(untracked.type, "new");
      assert.equal(untracked.hunks.length, 0);
      assert.ok(untracked.newObjectId, "the preview needs the new side named");
    },
  );

  await check(
    "a working-tree patch's new side reads off the disk while it still hashes the same",
    async (track) => {
      const { repo } = seedRepo(track);
      writeFileSync(join(repo, "board.png"), OLD);
      const edited = onlyFile(await getFileDiff(repo, ["board.png"], false));
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
      const untracked = onlyFile(await getFileDiff(repo, ["fresh.png"], true));
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
    },
  );

  await check(
    "a pure rename names no blobs, so it gets no preview",
    async (track) => {
      const { repo } = seedRepo(track);
      git(repo, "mv", "board.png", "moved.png");
      const renamed = onlyFile(
        await getFileDiff(repo, ["board.png", "moved.png"], false),
      );
      assert.equal(renamed.type, "rename-pure");
      assert.equal(renamed.newObjectId, undefined);
    },
  );

  await check(
    "a blob with a media name reads as text when it is text, and an unknown one as missing",
    async (track) => {
      const { repo } = seedRepo(track);
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
    },
  );

  await check("media types go by the name's extension", () => {
    assert.equal(mediaTypeOf("data/textures/board.PNG"), "image/png");
    assert.equal(mediaTypeOf("clip.mov"), "video/mp4");
    assert.equal(mediaTypeOf("icon.svg"), undefined);
    assert.equal(mediaTypeOf(".png"), undefined);
    assert.equal(mediaTypeOf("dir.png/readme"), undefined);
  });

  done();
}

main().catch(fail);
