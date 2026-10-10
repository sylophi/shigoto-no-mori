// The clone checkout against a fixture with everything it has to tell
// apart.

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { afterAll, describe, it } from "vitest";
import * as CloneCheckout from "../src/CloneCheckout.ts";
import * as Darwin from "../src/Darwin.ts";
import { ordinaryIndexFlags, parseLsFilesDebug } from "../src/gitIndex.ts";
import {
  beforeFirstClone,
  cloneRuntime,
  compareCheckouts,
  FIXTURE_TIME,
  git,
  scratch,
  seedRepo,
  write,
} from "./lib/cloneKit.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A primary checkout with everything a clone checkout has to tell apart:
// plain, executable and symlinked files, a submodule, a branch that
// differs from the primary's, and on disk an ignored folder, an
// untracked file, a dirty file, a touched-but-unchanged one and two
// deleted ones. Plus files git calls clean whose bytes aren't what a
// checkout writes: a filtered one, and line endings a checkout changes.
function cloneFixture(): string {
  const root = scratch("clone-fixture-");
  roots.push(root);
  const repo = seedRepo(root);
  git(repo, ["config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'"]);
  git(repo, ["config", "filter.upper.smudge", "tr '[:lower:]' '[:upper:]'"]);
  for (const [p, content] of Object.entries({
    ".gitattributes": "*.up filter=upper\n*.crlf eol=crlf\n*.txt text\n",
    "shout.up": "hello\n",
    "dos.crlf": "lf on disk\n",
    "win.txt": "crlf\r\non disk\r\n",
    ".gitignore": "node_modules/\n*.log\n",
    "README.md": "readme\n",
    "src/a.go": "package a\n",
    "src/deep/b.go": "package deep\n",
    "src/deep/c.txt": "c\n",
    "pure/one.txt": "one\n",
    "pure/sub/two.md": "two\n",
    "docs/x.md": "x\n",
    "docs/y.md": "y\n",
    "bin/run.sh": "#!/bin/sh\n",
    "vanished.md": "deleted on disk\n",
    "gone/away.txt": "deleted on disk\n",
  })) {
    write(join(repo, p), content);
  }
  chmodSync(join(repo, "bin/run.sh"), 0o755);
  symlinkSync("src/a.go", join(repo, "link"));
  symlinkSync("src", join(repo, "dirlink"));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "files"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},vendor/sub`,
  ]);
  git(repo, ["commit", "-q", "-m", "submodule"]);

  git(repo, ["checkout", "-q", "-b", "other"]);
  write(join(repo, "docs/y.md"), "y on other\n");
  write(join(repo, "docs/z.md"), "z\n");
  git(repo, ["rm", "-q", "src/deep/c.txt"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "other"]);
  git(repo, ["checkout", "-q", "main"]);

  // Old mtimes, so a clone (which keeps them) is told apart from a git
  // write (now).
  const age = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (dir === repo && name === ".git") continue;
      const full = join(dir, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      utimesSync(full, FIXTURE_TIME, FIXTURE_TIME);
      if (info.isDirectory()) age(full);
    }
  };
  age(repo);
  utimesSync(repo, FIXTURE_TIME, FIXTURE_TIME);
  git(repo, ["update-index", "-q", "--refresh"]);

  write(join(repo, "node_modules/pkg/index.js"), "ignored\n");
  write(join(repo, "app.log"), "ignored\n");
  write(join(repo, "src/new.txt"), "untracked\n");
  write(join(repo, "src/deep/b.go"), "package deep // dirty\n");
  write(join(repo, "docs/x.md"), "x\n");
  rmSync(join(repo, "vanished.md"));
  rmSync(join(repo, "gone/away.txt"));
  return repo;
}

const addNoCheckout = (
  repo: string,
  wt: string,
  branch: string,
  base: string,
) =>
  git(repo, [
    "worktree",
    "add",
    "-q",
    "-b",
    branch,
    "--no-checkout",
    "--",
    wt,
    base,
  ]);

// A clone checkout must leave exactly what `git worktree add` does.
const assertSameAsPlain = (repo: string, cloned: string, base: string) => {
  const plain = `${cloned}-plain`;
  git(repo, [
    "worktree",
    "add",
    "-q",
    "-b",
    `plain-${dirname(cloned).length}-${base}-${cloned.length}`,
    "--",
    plain,
    base,
  ]);
  assert.deepEqual(compareCheckouts(cloned, plain), []);
};

const withService = async <A>(
  body: (
    service: CloneCheckout.CloneCheckout["Service"],
  ) => Effect.Effect<A, unknown>,
  darwin?: Parameters<typeof cloneRuntime>[0],
) => {
  const runtime = cloneRuntime(darwin);
  try {
    return await runtime.runPromise(
      Effect.flatMap(Effect.service(CloneCheckout.CloneCheckout), body),
    );
  } finally {
    await runtime.dispose();
  }
};

describe("clone checkout", () => {
  for (const base of ["main", "other"]) {
    it(`matches a plain checkout of ${base}, cloning what it can`, async () => {
      const repo = cloneFixture();
      const wt = join(dirname(repo), `clone-${base}`);
      addNoCheckout(repo, wt, `clone-${base}`, base);
      const report = await withService((service) => service.clone(repo, wt));
      assert.ok(report.cloned > 0, `nothing cloned: ${JSON.stringify(report)}`);
      // Git trusts the stat written for the clones: a status finds
      // nothing to refresh, so the index stays byte-identical.
      const before = git(wt, ["ls-files", "-s", "--debug"]);
      git(wt, ["status", "--porcelain"]);
      assert.equal(git(wt, ["ls-files", "-s", "--debug"]), before);
      assertSameAsPlain(repo, wt, base);
      // Cloned, not written: the primary's old mtime survived.
      assert.equal(
        lstatSync(join(wt, "pure/sub/two.md")).mtimeMs,
        FIXTURE_TIME.getTime(),
      );
      // The dirty file came from git, with the commit's bytes.
      assert.equal(
        readFileSync(join(wt, "src/deep/b.go"), "utf8"),
        "package deep\n",
      );
    });
  }

  it("leaves an edit made mid-clone to git, and a file appearing mid-clone behind", async () => {
    const repo = cloneFixture();
    const wt = join(dirname(repo), "clone");
    addNoCheckout(repo, wt, "clone", "main");
    const report = await withService(
      (service) => service.clone(repo, wt),
      beforeFirstClone(() => {
        write(join(repo, "docs/y.md"), "edited mid-clone\n");
        write(join(repo, "pure/sub/sneaky.txt"), "new\n");
      }),
    );
    assert.ok(report.cloned > 0);
    assert.equal(readFileSync(join(wt, "docs/y.md"), "utf8"), "y\n");
    assert.equal(existsSync(join(wt, "pure/sub/sneaky.txt")), false);
    assert.equal(
      git(wt, ["status", "--porcelain", "--untracked-files=all"]),
      "",
    );
  });

  it("falls back to git when the clone fails, running the hook once", async () => {
    const repo = cloneFixture();
    const hookLog = join(scratch("clone-hook-"), "hook.log");
    write(
      join(repo, ".git/hooks/post-checkout"),
      `#!/bin/sh\necho "$@" >> '${hookLog}'\n`,
      0o755,
    );
    const wt = join(dirname(repo), "clone");
    addNoCheckout(repo, wt, "clone", "other");
    const outcome = await withService(
      (service) => service.finish({ source: repo, worktree: wt }),
      (real) => ({
        ...real,
        clone: ({ to }) =>
          Stream.fromEffect(
            Effect.sync(() => write(join(to, "partial"), "")).pipe(
              Effect.andThen(
                Effect.fail(
                  new Darwin.DarwinHelperError({
                    method: "clone",
                    reason: "exit",
                    cause: new Error("unsupported"),
                  }),
                ),
              ),
            ),
          ),
      }),
    );
    assert.ok(Result.isFailure(outcome));
    const head = git(wt, ["rev-parse", "HEAD"]).trim();
    assert.equal(
      readFileSync(hookLog, "utf8"),
      `${"0".repeat(head.length)} ${head} 1\n`,
    );
    rmSync(hookLog);
    assertSameAsPlain(repo, wt, "other");
  });
});

it("tells an ordinary index entry by its flags", () => {
  for (const [flags, want] of Object.entries({
    "0": true,
    "200000": true,
    "100000": true,
    "1000": false,
    "2000": false,
    "3000": false,
    "8000": false,
    "20000000": false,
    "40000000": false,
    zz: false,
  })) {
    assert.equal(ordinaryIndexFlags(flags), want, flags);
  }
});

it("reads ls-files --debug records, a path with a newline included", () => {
  const out =
    "100644 78981922613b2afb6025042ff6bd878ac1994e85 0\ta b\0" +
    "  ctime: 1:2\n  mtime: 3:4\n  dev: 5\tino: 6\n  uid: 7\tgid: 8\n  size: 9\tflags: 0\n" +
    "120000 2e65efe2a145dda7ee51d1741299f848e5bf752e 2\tline\nbreak\0" +
    "  ctime: 0:0\n  mtime: 0:0\n  dev: 0\tino: 0\n  uid: 0\tgid: 0\n  size: 0\tflags: 2000\n";
  const [first, second] = parseLsFilesDebug(out);
  assert.deepEqual(first, {
    mode: 0o100644,
    oid: "78981922613b2afb6025042ff6bd878ac1994e85",
    stage: 0,
    path: "a b",
    flags: "0",
    stat: {
      ctimeSec: 1,
      ctimeNsec: 2,
      mtimeSec: 3,
      mtimeNsec: 4,
      dev: 5,
      ino: 6,
      mode: 0,
      uid: 7,
      gid: 8,
      size: 9,
    },
  });
  assert.equal(second?.path, "line\nbreak");
  assert.equal(second?.stage, 2);
  assert.equal(second?.flags, "2000");
});
