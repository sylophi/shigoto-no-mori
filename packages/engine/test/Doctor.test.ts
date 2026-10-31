// The doctor's fixes that delete: the v2-files check, which deletes the
// files a 2.x data dir kept once the import is verified, and the prune
// of git's worktree metadata, which never runs while a moved worktree is
// unlinked or unseen. Against a hand-seeded data dir so the real ~/.sm
// is never read.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Doctor from "../src/Doctor.ts";
import { nativefs } from "./lib/nativefs.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const run = (options: { readonly fix?: boolean } = {}) =>
  box.engine(
    Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
      doctor.run({
        version: "dev",
        executable: "",
        terminal: false,
        ...(options.fix === true
          ? {
              fix: {
                approve: () => Effect.succeed(true),
                failed: () => Effect.void,
              },
            }
          : {}),
      }),
    ),
  ) as Promise<Doctor.DoctorDocument>;

const findingsFor = (doc: Doctor.DoctorDocument, id: string) =>
  doc.checks.filter((finding) => finding.id === id);

// The one finding with the id, which must have the status.
const only = (
  doc: Doctor.DoctorDocument,
  id: string,
  status: Doctor.Status,
): Doctor.Finding => {
  const found = findingsFor(doc, id);
  assert.equal(found.length, 1, `${id}: ${JSON.stringify(doc.checks)}`);
  const [finding] = found;
  assert.ok(finding);
  assert.equal(finding.status, status, finding.detail);
  return finding;
};

// A project "alpha" (A1) registered at <home>/alpha, configured on the
// in-project layout so its managed worktrees sit in the repo: one moved
// there by hand, git still listing it at its old path, and one whose
// folder is gone, whose record a prune would drop, severing the moved
// one with it.
const movedAndGone = () => {
  const repo = box.repo("alpha");
  box.write("registry.json", {
    projects: [{ id: "A1", name: "alpha", path: repo }],
  });
  box.write("projects/A1/project.json", {
    defaultBranch: "main",
    worktreeLayout: "in-project",
  });
  const base = join(repo, ".shigomori", "wt");
  const outside = join(box.home, "elsewhere", "feat");
  box.git(repo, "worktree", "add", "-q", "-b", "feat", outside);
  const gone = join(base, "gone");
  box.git(repo, "worktree", "add", "-q", "-b", "gone", gone);
  const moved = join(base, "feat");
  renameSync(outside, moved);
  rmSync(gone, { recursive: true });
  return { repo, base, moved };
};

it("reports the v2 files an unverified import left, and its fix leaves them", async () => {
  // A key the import skips: it can't verify the import, so the files
  // hold what the store doesn't.
  box.write("registry.json", { projects: [], unshelvedAt: { a: "x" } });
  const found = only(await run({ fix: true }), "v2-files", "warn");
  assert.match(found.detail, /may not hold/);
  assert.equal(found.repairable, undefined);
  assert.ok(existsSync(join(box.side("engine"), "registry.json")));
});

it("offers to delete a v2 file left as the import verified it, and leaves one written since to the person", async () => {
  box.write("registry.json", { projects: [] });
  box.write("config.json", { portPool: true });
  assert.deepEqual(findingsFor(await run(), "v2-files"), []);
  const side = box.side("engine");
  // A deletion that failed leaves the registry as it was verified, and a
  // v2 build started since writes a config of its own.
  writeFileSync(join(side, "registry.json"), JSON.stringify({ projects: [] }));
  writeFileSync(join(side, "config.json"), JSON.stringify({ portPool: false }));
  const found = findingsFor(await run(), "v2-files");
  assert.equal(found.length, 2);
  const fixed = await run({ fix: true });
  assert.deepEqual(fixed.repaired, ["deleted 1 v2 file"]);
  assert.ok(!existsSync(join(side, "registry.json")));
  assert.ok(existsSync(join(side, "config.json")));
  assert.match(
    only(fixed, "v2-files", "warn").detail,
    /config\.json left from v2, which the store may not hold/,
  );
});

it("won't prune while a moved worktree is still unlinked", async () => {
  const { repo, moved } = movedAndGone();
  // git can't write the re-link, so the moved worktree stays unlinked.
  const admin = join(repo, ".git", "worktrees", "feat");
  chmodSync(join(admin, "gitdir"), 0o444);
  chmodSync(admin, 0o555);
  try {
    await run({ fix: true });
  } finally {
    chmodSync(admin, 0o755);
    chmodSync(join(admin, "gitdir"), 0o644);
  }
  // The moved worktree's record can't be deleted here either, so only
  // the gone one's shows whether a prune ran.
  assert.ok(existsSync(join(repo, ".git", "worktrees", "gone")), "pruned");
  box.git(moved, "status");
});

it("prunes nothing while a managed folder can't be listed", async () => {
  const { base, moved } = movedAndGone();
  chmodSync(base, 0o311);
  try {
    await run({ fix: true });
  } finally {
    chmodSync(base, 0o755);
  }
  box.git(moved, "status");
});

it("prunes nothing it couldn't see when the filesystem helper fails", async () => {
  // A helper that can't lstat, as one that can't run would be.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "engine-nativefs-")));
  const broken = join(bin, "nativefs");
  writeFileSync(
    broken,
    `#!/bin/sh\nif [ "$1" = lstat ]; then echo "lstat refused" >&2; exit 3; fi\nexec '${nativefs()}' "$@"\n`,
    { mode: 0o755 },
  );
  await box.remove();
  box = sandbox({ nativefs: broken });
  try {
    const { moved } = movedAndGone();
    await run({ fix: true });
    box.git(moved, "status");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
