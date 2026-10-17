// The clone's pure phases, on made-up reads: the rules the clone relies
// on, without APFS or git.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LstatEntry } from "../src/Darwin.ts";
import {
  type IndexStat,
  type SourceEntry,
  type TreeEntry,
  verifiedRecord,
} from "../src/gitIndex.ts";
import {
  attributeCutoffs,
  attributeLooks,
  caseCollisions,
  clonablePaths,
  planUnits,
  stale,
  verdicts,
} from "../src/cloneCheckout/plan.ts";

const OID = "a".repeat(40);
const S = 1_000_000_000n;

const stat = (over: Partial<IndexStat> = {}): IndexStat => ({
  ctimeSec: 100,
  ctimeNsec: 0,
  mtimeSec: 100,
  mtimeNsec: 0,
  dev: 1,
  ino: 2,
  mode: 0o100644,
  uid: 501,
  gid: 20,
  size: 3,
  ...over,
});

const tree = (path: string, over: Partial<TreeEntry> = {}): TreeEntry => ({
  mode: 0o100644,
  oid: OID,
  path,
  ...over,
});

const entry = (path: string, over: Partial<SourceEntry> = {}): SourceEntry => ({
  ...tree(path),
  stage: 0,
  flags: "0",
  stat: stat(),
  ...over,
});

const lstat = (path: string, over: Partial<LstatEntry> = {}): LstatEntry => ({
  path,
  ...stat(),
  flags: 0,
  blocks: 1,
  nlink: 1,
  ...over,
});

describe("caseCollisions", () => {
  it("leaves names one disk folds together to git, folders included", () => {
    const collides = caseCollisions([
      tree("README"),
      tree("readme"),
      tree("Docs/a.md"),
      tree("docs/b.md"),
      tree("src/x.ts"),
      tree("src/y.ts"),
    ]);
    assert.equal(collides("README"), true);
    assert.equal(collides("readme"), true);
    assert.equal(collides("Docs/a.md"), true);
    assert.equal(collides("docs/b.md"), true);
    assert.equal(collides("src/x.ts"), false);
  });

  it("tells a file from a folder that differs only in case", () => {
    const collides = caseCollisions([tree("lib"), tree("LIB/x.ts")]);
    assert.equal(collides("lib"), true);
    assert.equal(collides("LIB/x.ts"), true);
    assert.equal(caseCollisions([tree("a/b"), tree("a/c")])("a/b"), false);
  });
});

describe("clonablePaths", () => {
  const plan = (
    target: TreeEntry,
    source: SourceEntry | undefined,
    over: Partial<Parameters<typeof clonablePaths>[0]> = {},
  ) =>
    clonablePaths({
      targets: [target],
      bySourcePath: new Map(
        source === undefined ? [] : [[source.path, source]],
      ),
      blobSize: new Map([[OID, 3]]),
      converted: new Set(),
      symlinks: true,
      collides: () => false,
      indexSec: 200,
      indexNsec: 0,
      ...over,
    }).has(target.path);

  it("takes an entry the source's index pins to the blob", () => {
    assert.equal(plan(tree("a"), entry("a")), true);
  });

  it("turns down a racily clean entry", () => {
    assert.equal(
      plan(tree("a"), entry("a", { stat: stat({ mtimeSec: 200 }) })),
      false,
    );
    assert.equal(
      plan(tree("a"), entry("a"), { indexSec: 100, indexNsec: 1 }),
      true,
    );
  });

  it("leaves to git what a checkout wouldn't write as the blob", () => {
    const cases: Array<[string, boolean]> = [
      ["no source entry", plan(tree("a"), undefined)],
      ["conflicted", plan(tree("a"), entry("a", { flags: "3000" }))],
      [
        "submodule",
        plan(tree("a", { mode: 0o160000 }), entry("a", { mode: 0o160000 })),
      ],
      [
        "symlink without core.symlinks",
        plan(tree("a", { mode: 0o120000 }), entry("a", { mode: 0o120000 }), {
          symlinks: false,
        }),
      ],
      ["another mode", plan(tree("a", { mode: 0o100755 }), entry("a"))],
      ["another blob", plan(tree("a"), entry("a", { oid: "b".repeat(40) }))],
      ["converted", plan(tree("a"), entry("a"), { converted: new Set(["a"]) })],
      ["outside ASCII", plan(tree("é"), entry("é"))],
      ["colliding", plan(tree("a"), entry("a"), { collides: () => true })],
      [
        "blob size unknown",
        plan(tree("a"), entry("a"), { blobSize: new Map() }),
      ],
      [
        "size not the blob's",
        plan(tree("a"), entry("a", { stat: stat({ size: 4 }) })),
      ],
    ];
    for (const [name, taken] of cases) assert.equal(taken, false, name);
  });
});

describe("planUnits", () => {
  it("clones a folder whole only when nothing else is in it", () => {
    const targets = [tree("app/a.ts"), tree("app/lib/b.ts")];
    const plan = planUnits({
      targets,
      sourceEntries: targets.map(({ path }) => entry(path)),
      others: ["app/notes.txt", ""],
      clonable: new Set(["app/a.ts", "app/lib/b.ts"]),
    });
    assert.deepEqual(plan.units, ["app/a.ts", "app/lib"]);
    assert.deepEqual([...plan.parents], ["app"]);
    assert.deepEqual([...plan.targetDirs].toSorted(), ["app", "app/lib"]);
    assert.deepEqual([...plan.tracked], ["app/a.ts", "app/lib/b.ts"]);
  });

  it("walks a folder holding a path not cloned, the source's or the target's", () => {
    const plan = planUnits({
      targets: [tree("src/a"), tree("src/b"), tree("docs/x/y")],
      sourceEntries: [entry("src/a"), entry("docs/x/y"), entry("docs/gone")],
      others: [],
      clonable: new Set(["src/a", "docs/x/y"]),
    });
    assert.deepEqual(plan.units, ["docs/x", "src/a"]);
    assert.deepEqual([...plan.parents].toSorted(), ["docs", "src"]);
  });

  it("clones a clean top folder as one unit", () => {
    const targets = [tree("src/a"), tree("src/b/c")];
    const plan = planUnits({
      targets,
      sourceEntries: targets.map(({ path }) => entry(path)),
      others: [],
      clonable: new Set(["src/a", "src/b/c"]),
    });
    assert.deepEqual(plan.units, ["src"]);
    assert.equal(plan.parents.size, 0);
  });
});

describe("the attribute cutoffs", () => {
  const files = {
    globalAttrs: "/h/.config/git/attributes",
    infoAttrs: "/s/.git/info/attributes",
    configFiles: ["/h/.gitconfig"],
  };
  const at = (sec: number, mode = 0o100644) =>
    lstat("", { ctimeSec: sec, mode });
  const dir = (sec: number) => at(sec, 0o040755);

  it("lstats every attributes file that applies, their folders and the config", () => {
    const { folders, toLstat } = attributeLooks(
      "/s",
      ["a/b/c.txt", "a/d.txt", "e.txt"],
      files,
    );
    assert.deepEqual(folders, ["a", "a/b"]);
    assert.deepEqual(toLstat, [
      "/h/.config/git/attributes",
      "/s/.git/info/attributes",
      "/s/.gitattributes",
      "/s/a/.gitattributes",
      "/s/a/b/.gitattributes",
      "/h/.config/git",
      "/s/.git/info",
      "/s",
      "/s/a",
      "/s/a/b",
      "/h/.gitconfig",
      "/h",
    ]);
  });

  it("dates a folder by the attributes above it, not its siblings'", () => {
    const { newest, attrsChanged } = attributeCutoffs(
      "/s",
      ["a", "a/b", "c"],
      files,
      new Map([
        ["/s/.gitattributes", at(10)],
        ["/s/a", dir(5)],
        ["/s/a/.gitattributes", at(20)],
        ["/s/a/b", dir(5)],
        ["/s/c", dir(30)],
      ]),
    );
    assert.equal(attrsChanged.get("."), 10n * S);
    assert.equal(attrsChanged.get("a"), 20n * S);
    assert.equal(attrsChanged.get("a/b"), 20n * S);
    // A deleted .gitattributes shows in its folder's ctime.
    assert.equal(attrsChanged.get("c"), 30n * S);
    assert.equal(newest, 30n * S);
  });

  it("counts a config change for every path but not as the newest", () => {
    const { newest, attrsChanged } = attributeCutoffs(
      "/s",
      ["a"],
      files,
      new Map([
        ["/h", dir(90)],
        ["/s/a", dir(5)],
      ]),
    );
    assert.equal(attrsChanged.get("."), 90n * S);
    assert.equal(attrsChanged.get("a"), 90n * S);
    assert.equal(newest, 5n * S);
  });

  it("takes no folder past a symlinked one", () => {
    const { realDir } = attributeCutoffs(
      "/s",
      ["a", "a/b", "c", "d"],
      files,
      new Map([
        ["/s/a", at(5, 0o120755)],
        ["/s/a/b", dir(5)],
        ["/s/c", dir(5)],
      ]),
    );
    assert.equal(realDir.get("."), true);
    assert.equal(realDir.get("a"), false);
    assert.equal(realDir.get("a/b"), false);
    assert.equal(realDir.get("c"), true);
    assert.equal(realDir.get("d"), false);
  });
});

describe("the verify verdicts", () => {
  const changed = new Map([
    [".", 0n],
    ["a", 150n * S],
  ]);

  it("calls an entry stale strictly before its attributes changed", () => {
    const bySourcePath = new Map([
      ["a/x", entry("a/x")],
      ["a/y", entry("a/y", { stat: stat({ ctimeSec: 150 }) })],
      ["z", entry("z")],
    ]);
    assert.equal(stale("a/x", bySourcePath, changed), true);
    assert.equal(stale("a/y", bySourcePath, changed), false);
    assert.equal(stale("z", bySourcePath, changed), false);
    assert.equal(stale("missing", bySourcePath, changed), false);
  });

  const judge = (
    paths: ReadonlyArray<string>,
    over: Partial<Parameters<typeof verdicts>[0]> = {},
  ) =>
    verdicts({
      clonable: paths,
      bySourcePath: new Map(paths.map((p) => [p, entry(p)])),
      sourceStats: new Map(paths.map((p) => [p, lstat(p)])),
      cloneStats: new Map(paths.map((p) => [p, lstat(p, { ino: 9 })])),
      sourceXattrs: new Map(paths.map((p) => [p, []])),
      realDir: new Map([
        [".", true],
        ["a", true],
      ]),
      mask: 0o022,
      attrsChanged: new Map([[".", 0n]]),
      verified: new Map(),
      ...over,
    });

  it("keeps a clone of an unchanged file with the clone's stat", () => {
    const { kept, rejected, toHash } = judge(["x"]);
    assert.deepEqual([...kept.keys()], ["x"]);
    assert.equal(kept.get("x")?.ino, 9);
    assert.deepEqual(rejected, []);
    assert.deepEqual(toHash, []);
  });

  it("rejects a path under a symlinked folder", () => {
    const { kept, rejected } = judge(["a/x", "b/y"], {
      realDir: new Map([
        [".", true],
        ["a", true],
        ["b", false],
      ]),
    });
    assert.deepEqual([...kept.keys()], ["a/x"]);
    assert.deepEqual(rejected, ["b/y"]);
  });

  it("rejects what a checkout wouldn't have written", () => {
    const one = (over: Partial<Parameters<typeof verdicts>[0]>) =>
      judge(["x"], over).rejected;
    const cases: Array<[string, string[]]> = [
      ["source gone", one({ sourceStats: new Map() })],
      ["clone gone", one({ cloneStats: new Map() })],
      ["xattrs unread", one({ sourceXattrs: new Map() })],
      [
        "source rewritten",
        one({ sourceStats: new Map([["x", lstat("x", { ctimeSec: 101 })]]) }),
      ],
      [
        "executable on disk",
        one({ sourceStats: new Map([["x", lstat("x", { mode: 0o100755 })]]) }),
      ],
      ["another umask", one({ mask: 0o002 })],
      [
        "a file flag",
        one({ sourceStats: new Map([["x", lstat("x", { flags: 0x8000 })]]) }),
      ],
      [
        "an xattr",
        one({ sourceXattrs: new Map([["x", ["com.apple.quarantine"]]]) }),
      ],
      [
        "not our clone",
        one({ cloneStats: new Map([["x", lstat("x", { mtimeNsec: 1 })]]) }),
      ],
    ];
    for (const [name, rejected] of cases) {
      assert.deepEqual(rejected, ["x"], name);
    }
    assert.deepEqual(
      one({ sourceXattrs: new Map([["x", ["com.apple.provenance"]]]) }),
      [],
    );
  });

  it("hashes a stale clone unless an earlier one proved that version", () => {
    const record = verifiedRecord(OID, stat());
    const { kept, toHash } = judge(["a/x", "a/y"], {
      attrsChanged: changed,
      verified: new Map([["a/y", record]]),
    });
    assert.deepEqual(
      toHash.map((hash) => [hash.p, hash.record]),
      [["a/x", record]],
    );
    assert.deepEqual([...kept.keys()], ["a/y"]);
  });
});
