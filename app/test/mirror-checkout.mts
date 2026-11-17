// Durable proof that a mirror's copy reads and writes its files the way
// its original's checkout does (host/lib/sync/landing.ts, the engine's
// create), so the file half, which carries bytes as they are, has
// nothing to fight over, and git agrees with itself on both ends.
// mirror:startTo runs for real: the send over a REAL direct websocket,
// the landing on the listener, the engine's create with REAL git. The
// mirror engine is the recording stand-in (lib/mirrorFakes.mts, its
// real runs are test/mirror.mts's): what is pinned here is that git on
// both ends writes the same bytes, which is all the engine would carry.
// For each pairing of a Windows original (core.autocrlf=true,
// core.symlinks=false, core.filemode=false) and a Mac one, with the
// copy's device of the other kind, asserts:
//   - after the start, every tracked file holds the same bytes on both
//     ends and `git status` is clean on both,
//   - `git checkout -- <file>`, `git stash` and `git stash pop` on either
//     end keep that, with the bytes carried to the other end as the
//     engine would,
//   - a file committed on the copy is the blob the original would stage,
//   - a file a Windows original holds with bytes its checkout wouldn't
//     write (LF where it writes CRLF) reads clean on the copy, and the
//     original's staged and unstaged changes read there as they do on
//     the original,
//   - the copy's device's other worktrees keep their own config,
//   - a copy whose device's checkout is the original's own writes
//     nothing into its repository's config.
// And for tracked symlinks:
//   - a Mac original's link is a link on the copy where this OS can make
//     one, and the start is refused where it can't,
//   - a copy's device that can't make links refuses a Mac original's,
//     before anything lands, and takes a Windows original's (plain
//     files there) as they are.
//
// Both "devices" share one process, one global git config and one
// sandboxed data dir, as in test/control.mts. Each device's kind is its
// repository's own config, which git reads under the copy's per-worktree
// one the same as a global one. Run: pnpm test mirror-checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "@shigomori/engine/canonicalPath";
import { afterAll, beforeAll, it } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreeDataHandlers } from "@host/ipc/modules/worktreeData";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import { handlerCtx, makeTracker } from "./lib/checkKit.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { bootDirectWire, DIALER, LISTENER } from "./lib/directBoot.mts";
import { runHost } from "./lib/hostRuntime.mts";
import {
  standInDeviceId,
  standInMirror,
  standInPeers,
} from "./lib/hostStandIns.mts";
import { recordingMirror } from "./lib/mirrorFakes.mts";

const fixture = cliSandbox("sm-mirror-checkout-");
const { sandbox, git, gitOut } = fixture;

const { track, teardown } = makeTracker();
afterAll(async () => {
  await teardown();
  await fixture.remove();
});

// The mirror engine's stand-in, whose start's replica pass writes the
// original's bytes at every tracked path over what the copy's checkout
// wrote.
standInMirror(
  recordingMirror({}, (input) => {
    if (input.direction !== "replica") return;
    for (const file of execFileSync("git", ["ls-files", "-z"], {
      cwd: input.localRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)) {
      if (!lstatSync(join(input.localRoot, file)).isSymbolicLink()) {
        carry(input.localRoot, input.remoteRoot, file);
      }
    }
  }).impl,
);

// A device's kind, as its git is set up. A Mac's filemode is what git
// found the filesystem holds (`probed`).
type Kind = "windows" | "mac";
const kindConfig = (kind: Kind, probed: string) =>
  kind === "windows"
    ? {
        "core.autocrlf": "true",
        "core.symlinks": "false",
        "core.filemode": "false",
      }
    : {
        "core.autocrlf": "false",
        "core.symlinks": "true",
        "core.filemode": probed,
      };

let sourceRepo: string;
let targetRepo: string;
let sourceProjectId: string;
let otherWorktree: string;
const probedFilemode = new Map<string, string>();
// Whether this OS lets this process make a symlink.
let canLink: boolean;
// The listener's landing finds that symlinks can't be made.
let linksRefused = false;

// The listener's landing, on a filesystem that makes no symlink while
// `linksRefused` holds, as Windows refuses one without Developer Mode.
const receiveWorktree: typeof syncHandlers.receiveWorktree = (input, ctx) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    syncHandlers.receiveWorktree(input, ctx).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        linksRefused
          ? {
              ...fs,
              symlink: (_target, path) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "symlink",
                    pathOrDescriptor: path,
                  }),
                ),
            }
          : fs,
      ),
    ),
  );

const setKind = async (repo: string, kind: Kind) => {
  for (const [key, value] of Object.entries(
    kindConfig(kind, probedFilemode.get(repo) ?? "true"),
  )) {
    await git(repo, ["config", key, value]);
  }
};

beforeAll(async () => {
  await fixture.buildSm();

  // main holds a text file and an executable, `links` adds a tracked
  // symlink to the text file, written with plumbing so no checkout has
  // to make it.
  sourceRepo = await fixture.initRepo("source");
  writeFileSync(join(sourceRepo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(sourceRepo, "run.sh"), "#!/bin/sh\necho run\n");
  await git(sourceRepo, ["add", "a.txt", "run.sh"]);
  await git(sourceRepo, ["update-index", "--chmod=+x", "run.sh"]);
  await git(sourceRepo, ["commit", "-qm", "base"]);
  const linkBlob = gitIn(sourceRepo, ["hash-object", "-w", "--stdin"], "a.txt");
  const tree = gitIn(
    sourceRepo,
    ["mktree"],
    `${await gitOut(sourceRepo, "ls-tree", "main")}\n120000 blob ${linkBlob}\tlink\n`,
  );
  const commit = await gitOut(
    sourceRepo,
    "commit-tree",
    tree,
    "-p",
    "main",
    "-m",
    "links",
  );
  await git(sourceRepo, ["branch", "links", commit]);

  targetRepo = await fixture.cloneRepo(sourceRepo, "target");
  otherWorktree = await fixture.addWorktree(
    targetRepo,
    "target-other",
    "other",
  );
  for (const repo of [sourceRepo, targetRepo]) {
    probedFilemode.set(repo, await gitOut(repo, "config", "core.filemode"));
  }

  try {
    symlinkSync("a.txt", join(sandbox, "probe-link"));
    rmSync(join(sandbox, "probe-link"));
    canLink = true;
  } catch {
    canLink = false;
  }

  await fixture.useCli();
  // Target first: the peer's identity scan takes the first registry
  // match, which must be the peer's own checkout.
  await fixture.projectIdOf(targetRepo);
  sourceProjectId = await fixture.projectIdOf(sourceRepo);

  const { listener, toListener } = await bootDirectWire(track, {
    contracts: [
      [
        syncContract,
        {
          ...syncHandlers,
          receiveWorktree,
        },
      ],
      [worktreesContract, worktreesHandlers],
      [worktreeDataContract, worktreeDataHandlers],
      [mirrorContract, mirrorHandlers],
    ],
  });
  listener.setAccepts(true);
  standInPeers(toListener);
  standInDeviceId(DIALER);
});

// git fed `input` on stdin, in the sandbox's scrubbed environment.
function gitIn(repo: string, args: string[], input: string) {
  return execFileSync("git", args, {
    cwd: repo,
    input,
    encoding: "utf8",
  }).trim();
}

// An original on a new branch off `base`, checked out by git under the
// source's config. `indexOnly` leaves its files out (a link this OS
// can't make).
async function original(name: string, base: string, indexOnly = false) {
  const path = join(sandbox, name);
  await git(sourceRepo, [
    "worktree",
    "add",
    "-q",
    ...(indexOnly ? ["--no-checkout"] : []),
    "-b",
    name,
    path,
    base,
  ]);
  if (indexOnly) await git(path, ["reset", "-q"]);
  return path;
}

const start = (originalPath: string) =>
  runHost(
    mirrorHandlers.startTo(
      {
        targetDeviceId: LISTENER,
        projectId: sourceProjectId,
        worktreeId: worktreeIdFromPath(originalPath),
        ignoreMode: "gitignored",
        ignores: [],
      },
      handlerCtx(),
    ),
  );

const status = async (path: string) =>
  (await git(path, ["status", "--porcelain"])).stdout.trimEnd();

// What sits at a tracked path: a link's target, or a file's bytes.
const entryAt = (root: string, file: string) => {
  const full = join(root, file);
  return lstatSync(full).isSymbolicLink()
    ? `link:${readlinkSync(full)}`
    : readFileSync(full).toString("latin1");
};

// The two ends hold the same bytes at every tracked path, and git on
// each reads its own as clean.
async function inStep(a: string, b: string, what: string) {
  const files = (await gitOut(a, "ls-files")).split("\n").filter(Boolean);
  for (const file of files) {
    assert.equal(entryAt(b, file), entryAt(a, file), `${what}: ${file}`);
  }
  assert.equal(await status(a), "", `${what}: status at ${a}`);
  assert.equal(await status(b), "", `${what}: status at ${b}`);
}

// The line ending `path` is written with.
const eolOf = (path: string) =>
  readFileSync(path, "latin1").includes("\r\n") ? "\r\n" : "\n";

// What the file half does with an edit: the bytes, as they are.
const carry = (from: string, to: string, file: string) =>
  writeFileSync(join(to, file), readFileSync(join(from, file)));

// git's own verbs on one end, the other end taking what they wrote.
async function gitVerbs(end: string, other: string, what: string) {
  const file = join(end, "a.txt");
  writeFileSync(file, "edited\n");
  await git(end, ["checkout", "--", "a.txt"]);
  await inStep(end, other, `${what}, after checkout --`);

  writeFileSync(file, `${readFileSync(file, "latin1")}three${eolOf(file)}`);
  await git(end, ["stash", "-q"]);
  await inStep(end, other, `${what}, after stash`);
  await git(end, ["stash", "pop", "-q"]);
  carry(end, other, "a.txt");
  assert.equal(await status(end), " M a.txt", `${what}, after stash pop`);
  assert.equal(await status(other), " M a.txt", `${what}, the popped edit`);
  assert.equal(
    await gitOut(other, "diff"),
    await gitOut(end, "diff"),
    `${what}: the two ends read the edit alike`,
  );
  await git(end, ["checkout", "--", "a.txt"]);
  carry(end, other, "a.txt");
  await inStep(end, other, `${what}, back`);
}

// A file written on the copy and committed there is the blob the
// original stages from the same bytes.
async function commitsAlike(originalPath: string, copy: string) {
  const eol = eolOf(join(originalPath, "a.txt"));
  for (const root of [originalPath, copy]) {
    writeFileSync(join(root, "new.txt"), `x${eol}y${eol}`);
    await git(root, ["add", "new.txt"]);
  }
  await git(copy, ["commit", "-qm", "new"]);
  assert.equal(
    await gitOut(copy, "rev-parse", "HEAD:new.txt"),
    await gitOut(originalPath, "rev-parse", ":new.txt"),
    "a commit on the copy holds what the original would commit",
  );
  assert.equal(
    await gitOut(copy, "cat-file", "-p", "HEAD:new.txt"),
    "x\ny",
    "history holds LF",
  );
}

// The copy's device's other worktrees read the repository's own config.
async function othersKeepTheirs(kind: Kind, before: string) {
  const want = kindConfig(kind, probedFilemode.get(targetRepo) ?? "true");
  for (const root of [targetRepo, otherWorktree]) {
    for (const [key, value] of Object.entries(want)) {
      assert.equal(
        await gitOut(root, "config", "--type=bool", key),
        value,
        `${key} at ${root}`,
      );
    }
  }
  assert.equal(await status(otherWorktree), before);
}

// First, while the copy's repository has never had a copy land in it.
it("two ends of one kind leave the copy's repository config as it was, and two of different kinds still read clean", async () => {
  await setKind(sourceRepo, "mac");
  await setKind(targetRepo, "mac");
  const common = await gitOut(
    targetRepo,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const config = readFileSync(join(common, "config"), "utf8");
  const sameKind = await original("same-kind", "main");
  const { worktree: copy } = await start(sameKind);
  await inStep(sameKind, copy.path, "one kind");
  assert.equal(
    readFileSync(join(common, "config"), "utf8"),
    config,
    "the repository's config is as it was",
  );
  assert.doesNotMatch(config, /worktreeConfig/);
  for (const file of [
    join(common, "config.worktree"),
    await gitOut(
      copy.path,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "config.worktree",
    ),
  ]) {
    assert.equal(existsSync(file), false, `no ${file}`);
  }

  await setKind(sourceRepo, "windows");
  const otherKind = await original("other-kind", "main");
  const { worktree: otherCopy } = await start(otherKind);
  await inStep(otherKind, otherCopy.path, "two kinds");
});

for (const [originalKind, copyKind] of [
  ["windows", "mac"],
  ["mac", "windows"],
] as const) {
  it(`a ${originalKind} original's copy on a ${copyKind} device holds its bytes, and git's verbs on either end keep both clean`, async () => {
    await setKind(sourceRepo, originalKind);
    await setKind(targetRepo, copyKind);
    const before = await status(otherWorktree);
    const originalPath = await original(`${originalKind}-orig`, "main");
    const { worktree } = await start(originalPath);
    const copy = worktree.path;

    await inStep(originalPath, copy, "after the start");
    assert.equal(
      eolOf(join(copy, "a.txt")),
      originalKind === "windows" ? "\r\n" : "\n",
      "the copy's line endings are the original's",
    );
    await gitVerbs(copy, originalPath, "on the copy");
    await gitVerbs(originalPath, copy, "on the original");
    await othersKeepTheirs(copyKind, before);
    await commitsAlike(originalPath, copy);
  });
}

it("a windows original's file whose bytes on disk aren't what git would write reads clean on the copy, and the original's uncommitted changes read on the copy as they do there", async () => {
  await setKind(sourceRepo, "windows");
  await setKind(targetRepo, "mac");
  const originalPath = await original("lf-on-disk", "main");
  writeFileSync(join(originalPath, "lf.txt"), "lf\nonly\n");
  await git(originalPath, ["add", "lf.txt"]);
  await git(originalPath, ["commit", "-qm", "lf"]);
  writeFileSync(join(originalPath, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(originalPath, "staged.txt"), "staged\n");
  await git(originalPath, ["add", "staged.txt"]);
  const want = " M a.txt\nA  staged.txt";
  assert.equal(await status(originalPath), want);

  const { worktree } = await start(originalPath);
  const copy = worktree.path;
  for (const file of ["lf.txt", "a.txt", "staged.txt"]) {
    assert.equal(entryAt(copy, file), entryAt(originalPath, file), file);
  }
  assert.equal(await status(copy), want);
  for (const args of [["diff"], ["diff", "--cached"]]) {
    assert.equal(
      await gitOut(copy, ...args),
      await gitOut(originalPath, ...args),
      args.join(" "),
    );
  }
});

it("a mac original's tracked symlink is a link on the copy where this OS makes links, and the start is refused where it can't", async () => {
  await setKind(sourceRepo, "mac");
  await setKind(targetRepo, "windows");
  const originalPath = await original("mac-links", "links", !canLink);
  if (!canLink) {
    await assert.rejects(start(originalPath), /tracks symlinks/);
    assert.equal(
      await gitOut(targetRepo, "branch", "--list", "mac-links"),
      "",
      "nothing lands",
    );
    return;
  }
  const { worktree } = await start(originalPath);
  assert.equal(lstatSync(join(worktree.path, "link")).isSymbolicLink(), true);
  await inStep(originalPath, worktree.path, "a link on both ends");
});

it("a copy's device that can't make symlinks refuses a mac original's before anything lands, and takes a windows original's as files", async () => {
  linksRefused = true;
  try {
    await setKind(sourceRepo, "mac");
    await setKind(targetRepo, "mac");
    const macOriginal = await original("refused-links", "links", !canLink);
    await assert.rejects(
      start(macOriginal),
      /This worktree tracks symlinks, which can't be made where its copy would go/,
    );
    assert.equal(
      await gitOut(targetRepo, "branch", "--list", "refused-links"),
      "",
      "nothing lands",
    );

    await setKind(sourceRepo, "windows");
    const windowsOriginal = await original("file-links", "links");
    const { worktree } = await start(windowsOriginal);
    assert.equal(lstatSync(join(worktree.path, "link")).isFile(), true);
    await inStep(windowsOriginal, worktree.path, "a link as a file");
  } finally {
    linksRefused = false;
  }
});
