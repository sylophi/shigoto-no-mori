// Random repos and random states of the source checkout, each cloned and
// checked out plainly from a random commit: the two must match. Ported
// from the Go CLI's clonecheckout_fuzz_test.go, scenario for scenario.
// CLONE_FUZZ_N sets how many (default 25), CLONE_FUZZ_SEED the first
// seed, so a failure reruns alone with CLONE_FUZZ_N=1 and its seed.
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, it } from "vitest";
import * as CloneCheckout from "../src/CloneCheckout.ts";
import {
  beforeFirstClone,
  cloneRuntime,
  compareCheckouts,
  FIXTURE_TIME,
  git,
  scratch,
  seedRepo,
  tryGit,
} from "./lib/cloneKit.ts";

const count = Number(process.env.CLONE_FUZZ_N ?? 25);
const first = Number(process.env.CLONE_FUZZ_SEED ?? 1);

// splitmix64, seeded: the same seed makes the same scenario.
const random = (seed: number) => {
  let state = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n);
  const next = () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
  return (n: number) => Number(next() % BigInt(n));
};

const DIRS = [
  "",
  "",
  "a/",
  "A/",
  "a/b/",
  "a/B/",
  "Docs/",
  "docs/",
  "deep/x/y/",
  "sp ace/",
  "ign/",
];
const NAMES = [
  "f",
  "F",
  "g.txt",
  "G.txt",
  "run.sh",
  "x.up",
  "crlf.txt",
  "bin.dat",
  "-dash",
  "uni-é",
  "l",
];
const BODIES = [
  "",
  "x\n",
  "y\n",
  "hello\n",
  "line\r\nline\r\n",
  "mixed\r\nlf\n",
  `BIG ${"z".repeat(5000)}\n`,
  "\x00\x01binary\n",
];
const ATTRS = [
  "*.up filter=upper",
  "*.txt text",
  "crlf.txt eol=crlf",
  "*.sh -text",
  "bin.dat binary",
  "* text=auto",
  "g.txt ident",
  "*.txt eol=lf",
];

const isAscii = (text: string) =>
  [...text].every((c) => c.charCodeAt(0) < 0x80);

const flipCase = (name: string) => {
  for (let i = 0; i < name.length; i++) {
    const c = name[i] ?? "";
    if (c >= "a" && c <= "z") {
      return name.slice(0, i) + c.toUpperCase() + name.slice(i + 1);
    }
    if (c >= "A" && c <= "Z") {
      return name.slice(0, i) + c.toLowerCase() + name.slice(i + 1);
    }
  }
  return `${name}X`;
};

const quietly = (body: () => void) => {
  try {
    body();
  } catch {
    // A mutation never fails the test: it also runs mid-clone.
  }
};

class Scenario {
  readonly log: string[] = [];
  readonly repo: string;
  readonly intn: (n: number) => number;

  constructor(seed: number) {
    this.intn = random(seed);
    this.repo = seedRepo(scratch("clone-fuzz-"));
  }

  pick<T>(options: ReadonlyArray<T>): T {
    return options[this.intn(options.length)] as T;
  }

  // A tree of random entries, written straight into the object store (so
  // it can hold what a case-insensitive disk can't check out), as a commit
  // on its own branch.
  commit(branch: string, gitlink: string) {
    const entries = new Map<string, string>();
    const dirs = new Set<string>();
    const blob = (content: string) =>
      git(this.repo, ["hash-object", "-w", "--stdin"], {
        input: content,
      }).trim();
    const add = (p: string, mode: string, oid: string) => {
      for (let d = dirname(p); d !== "."; d = dirname(d)) {
        if (entries.has(d)) return;
      }
      if (dirs.has(p)) return;
      entries.set(p, `${mode} ${oid}`);
      for (let d = dirname(p); d !== "."; d = dirname(d)) dirs.add(d);
    };
    const total = 4 + this.intn(22);
    for (let i = 0; i < total; i++) {
      const p = this.pick(DIRS) + this.pick(NAMES);
      const k = this.intn(20);
      if (k < 12) add(p, "100644", blob(this.pick(BODIES)));
      else if (k < 15)
        add(p, "100755", blob(`#!/bin/sh\necho ${this.pick(["a", "b"])}\n`));
      else if (k < 18) {
        add(
          p,
          "120000",
          blob(this.pick(["f", "../f", "a", "a/b", "nowhere", "/etc/hosts"])),
        );
      } else if (k < 19 && gitlink !== "") add(p, "160000", gitlink);
      // A file where an earlier commit may have had a directory.
      else
        add(
          this.pick(DIRS.slice(2)).replace(/\/$/, ""),
          "100644",
          blob("was a dir\n"),
        );
    }
    if (this.intn(2) === 0) {
      const lines: string[] = [];
      const many = 1 + this.intn(3);
      for (let i = 0; i < many; i++) lines.push(this.pick(ATTRS));
      add(
        `${this.pick(["", "a/"])}.gitattributes`,
        "100644",
        blob(`${lines.join("\n")}\n`),
      );
    }
    add(".gitignore", "100644", blob("*.log\nign/\n"));

    const index = join(scratch("clone-index-"), "index");
    const info = [...entries].map(([p, e]) => `${e}\t${p}\n`).join("");
    const env = { GIT_INDEX_FILE: index };
    git(this.repo, ["update-index", "--add", "--index-info"], {
      input: info,
      env,
    });
    const tree = git(this.repo, ["write-tree"], { env }).trim();
    const c = git(this.repo, ["commit-tree", tree, "-m", branch]).trim();
    git(this.repo, ["branch", "-f", branch, c]);
    this.log.push(`commit ${branch}: ${entries.size} entries`);
  }

  trackedPaths() {
    return git(this.repo, ["ls-files", "-z"])
      .split("\0")
      .filter((p) => p !== "");
  }

  // One random change to the source checkout, on disk or in its index.
  mutate(paths: ReadonlyArray<string>) {
    if (paths.length === 0) return;
    const p = this.pick(paths);
    const abs = join(this.repo, p);
    // Mutations stay inside the repo: none goes through a symlink the
    // mutations before it made.
    for (let d = p; d !== "."; d = dirname(d)) {
      try {
        if (lstatSync(join(this.repo, d)).isSymbolicLink()) return;
      } catch {
        // Not there: nothing to go through.
      }
    }
    const write = (rel: string, content: string) =>
      quietly(() => {
        const full = join(this.repo, rel);
        mkdirSync(dirname(full), { recursive: true });
        rmSync(full, { recursive: true, force: true });
        writeFileSync(full, content, { mode: 0o644 });
      });
    const exists = (rel: string) => {
      try {
        lstatSync(join(this.repo, rel));
        return true;
      } catch {
        return false;
      }
    };
    const k = this.intn(27);
    switch (k) {
      case 0:
        this.log.push(`edit ${p} (same size)`);
        quietly(() => {
          const bytes = readFileSync(abs);
          if (bytes.length > 0) {
            bytes[0] = (bytes[0] ?? 0) ^ 1;
            writeFileSync(abs, bytes);
          }
        });
        break;
      case 1:
        this.log.push(`edit ${p}`);
        write(p, "edited\n");
        break;
      case 2:
        this.log.push(`delete ${p}`);
        quietly(() => rmSync(abs, { recursive: true, force: true }));
        break;
      case 3:
        this.log.push(`chmod ${p} 755`);
        quietly(() => chmodSync(abs, 0o755));
        break;
      case 4:
        this.log.push(`chmod ${p} 644`);
        quietly(() => chmodSync(abs, 0o644));
        break;
      case 5: {
        const mode = this.pick(["444", "600", "664"]);
        this.log.push(`chmod ${p} ${mode}`);
        quietly(() => chmodSync(abs, Number.parseInt(mode, 8)));
        break;
      }
      case 6:
        this.log.push(`touch ${p}`);
        quietly(() => utimesSync(abs, new Date(), new Date()));
        break;
      case 7:
        this.log.push(`replace ${p} with a dir`);
        quietly(() => rmSync(abs, { recursive: true, force: true }));
        write(`${p}/inner`, "inner\n");
        break;
      case 8: {
        const d = dirname(p);
        if (d !== ".") {
          this.log.push(`replace dir ${d} with a file`);
          write(d, "now a file\n");
        }
        break;
      }
      case 9: {
        const f = join(
          dirname(p),
          this.pick(["untracked", "new.txt", "F", ".DS_Store"]),
        );
        this.log.push(`untracked ${f}`);
        if (!exists(f)) write(f, "untracked\n");
        break;
      }
      case 10: {
        const f = this.pick([join(dirname(p), "x.log"), "ign/deep/junk"]);
        this.log.push(`ignored ${f}`);
        if (!exists(f)) write(f, "ignored\n");
        break;
      }
      case 11:
        this.log.push(`stage an edit to ${p}`);
        write(p, "staged\n");
        tryGit(this.repo, ["add", "--", p]);
        break;
      case 12: {
        const f = join(dirname(p), "ita");
        this.log.push(`intent-to-add ${f}`);
        write(f, "ita\n");
        tryGit(this.repo, ["add", "-N", "--", f]);
        break;
      }
      case 13:
        this.log.push(`assume-unchanged ${p}, then edit`);
        tryGit(this.repo, ["update-index", "--assume-unchanged", "--", p]);
        write(p, "assumed\n");
        break;
      case 14:
        this.log.push(`skip-worktree ${p}, then delete`);
        tryGit(this.repo, ["update-index", "--skip-worktree", "--", p]);
        quietly(() => rmSync(abs, { recursive: true, force: true }));
        break;
      case 15: {
        const other = join(
          dirname(p),
          flipCase(p.slice(p.lastIndexOf("/") + 1)),
        );
        this.log.push(`rename ${p} to ${other} on disk`);
        quietly(() => {
          renameSync(abs, `${abs}.tmp-rename`);
          renameSync(`${abs}.tmp-rename`, join(this.repo, other));
        });
        break;
      }
      case 16: {
        const d = join(dirname(p), "emptydir");
        this.log.push(`empty dir ${d}`);
        quietly(() => mkdirSync(join(this.repo, d), { recursive: true }));
        break;
      }
      case 17: {
        const d = dirname(p);
        if (d !== ".") {
          const mode = this.pick(["700", "750", "775"]);
          this.log.push(`chmod dir ${d} ${mode}`);
          quietly(() =>
            chmodSync(join(this.repo, d), Number.parseInt(mode, 8)),
          );
        }
        break;
      }
      case 18:
        this.log.push(`symlink ${p}`);
        quietly(() => {
          rmSync(abs, { recursive: true, force: true });
          symlinkSync(this.pick(["f", "nowhere", ".."]), abs);
        });
        break;
      case 19:
        // Has the index vouch for the file as it is now, chmods and all.
        this.log.push(`re-add ${p}`);
        tryGit(this.repo, ["rm", "-q", "--cached", "--", p]);
        tryGit(this.repo, ["add", "--", p]);
        break;
      case 20:
        this.log.push(`chmod ${p} 000`);
        quietly(() => chmodSync(abs, 0));
        break;
      case 21: {
        const d = dirname(p);
        if (d !== ".") {
          this.log.push(`replace dir ${d} with a symlink`);
          quietly(() => {
            rmSync(join(this.repo, d), { recursive: true, force: true });
            symlinkSync(
              this.pick(["..", "/tmp", "nowhere"]),
              join(this.repo, d),
            );
          });
        }
        break;
      }
      case 22: {
        const f = this.pick([
          ".gitattributes",
          "a/.gitattributes",
          "Docs/.gitattributes",
        ]);
        const line = this.pick(ATTRS);
        this.log.push(`append ${JSON.stringify(line)} to ${f}`);
        quietly(() => appendFileSync(join(this.repo, f), `${line}\n`));
        break;
      }
      case 23: {
        const f = this.pick([
          ".gitattributes",
          "a/.gitattributes",
          ".git/info/attributes",
        ]);
        this.log.push(`delete ${f}`);
        quietly(() => rmSync(join(this.repo, f)));
        break;
      }
      case 24: {
        const line = this.pick(ATTRS);
        this.log.push(`info/attributes: ${JSON.stringify(line)}`);
        writeInfo(this.repo, `${line}\n`);
        break;
      }
      default: {
        // The case only a read-back catches: git records a file through a
        // filter, then the attribute goes and the file stays.
        if (/[ \x7f]/.test(p) || !isAscii(p)) return;
        let body: string;
        try {
          body = readFileSync(abs, "latin1");
        } catch {
          return;
        }
        const where = k === 25 ? ".git/info/attributes" : ".gitattributes";
        this.log.push(`record ${p} through a filter in ${where}, then drop it`);
        quietly(() => {
          const file = join(this.repo, where);
          let saved = "";
          try {
            saved = readFileSync(file, "latin1");
          } catch {
            // None yet.
          }
          writeFileSync(abs, body.toUpperCase(), {
            encoding: "latin1",
            mode: 0o644,
          });
          // Old enough that git doesn't take its record for racy.
          utimesSync(abs, FIXTURE_TIME, FIXTURE_TIME);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `${saved}/${p} filter=upper\n`, "latin1");
          tryGit(this.repo, ["rm", "-q", "--cached", "--", p]);
          tryGit(this.repo, ["add", "--", p]);
          writeFileSync(file, saved, "latin1");
        });
      }
    }
  }
}

const writeInfo = (repo: string, content: string) => {
  const file = join(repo, ".git/info/attributes");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

// Every folder under `root` made enterable again, so the scratch can go.
const unlock = (root: string) => {
  const walk = (dir: string) => {
    quietly(() => chmodSync(dir, 0o755));
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        if (lstatSync(full).isDirectory()) walk(full);
      } catch {
        // Gone.
      }
    }
  };
  walk(root);
};

async function runScenario(seed: number) {
  const s = new Scenario(seed);
  git(s.repo, ["config", "filter.upper.clean", "tr '[:upper:]' '[:lower:]'"]);
  git(s.repo, ["config", "filter.upper.smudge", "tr '[:lower:]' '[:upper:]'"]);
  if (s.intn(8) === 0) {
    const value = s.pick(["true", "input"]);
    s.log.push(`core.autocrlf=${value}`);
    git(s.repo, ["config", "core.autocrlf", value]);
  }
  if (s.intn(8) === 0) {
    s.log.push("info/attributes");
    writeInfo(s.repo, "*.sh filter=upper\n");
  }
  const gitlink = git(s.repo, ["rev-parse", "HEAD"]).trim();
  const branches = ["b0", "b1", "b2"];
  for (const branch of branches) s.commit(branch, gitlink);

  const from = s.pick(branches);
  s.log.push(`source on ${from}`);
  // A plain checkout can fail on what the disk can't hold. Its state is
  // still a state the source can be in.
  tryGit(s.repo, ["checkout", "-q", "-f", from]);
  if (s.intn(2) === 0) {
    s.log.push("age the files");
    const age = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (dir === s.repo && name === ".git") continue;
        const full = join(dir, name);
        const info = lstatSync(full);
        if (info.isSymbolicLink()) continue;
        quietly(() => utimesSync(full, FIXTURE_TIME, FIXTURE_TIME));
        if (info.isDirectory()) age(full);
      }
    };
    quietly(() => age(s.repo));
    tryGit(s.repo, ["update-index", "-q", "--refresh"]);
  }
  const mutations = s.intn(9);
  for (let i = 0; i < mutations; i++) s.mutate(s.trackedPaths());
  if (s.intn(3) === 0) {
    s.log.push("refresh");
    tryGit(s.repo, ["update-index", "-q", "--refresh"]);
  }

  const base = s.pick(branches);
  s.log.push(`clone ${base}`);
  const wt = join(dirname(s.repo), "clone");
  git(s.repo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "clone",
    "--no-checkout",
    "--",
    wt,
    base,
  ]);
  let midClone: Parameters<typeof cloneRuntime>[0];
  if (s.intn(3) === 0) {
    const paths = s.trackedPaths();
    const n = 1 + s.intn(4);
    s.log.push("mid-clone:");
    midClone = beforeFirstClone(() => {
      for (let i = 0; i < n; i++) s.mutate(paths);
    });
  }
  const runtime = cloneRuntime(midClone);
  try {
    const service = await runtime.runPromise(
      Effect.service(CloneCheckout.CloneCheckout),
    );
    const cloned = await runtime.runPromise(
      Effect.result(service.clone(s.repo, wt)),
    );
    if (Result.isFailure(cloned)) {
      // The one way a clone is meant to give up here: attributes changed
      // under it mid-clone. It then falls back as create does.
      assert.equal(
        cloned.failure.reason,
        "attributes-changed",
        `seed ${seed}: clone failed: ${cloned.failure.message}\n${s.log.join("\n")}`,
      );
      s.log.push(`clone gave way: ${cloned.failure.message}`);
      await runtime.runPromise(service.resetToPlainCheckout(wt));
    }
    const plain = `${wt}-plain`;
    // A plain checkout of a tree the disk can't hold errors out after
    // writing what it can. The clone must land the same.
    tryGit(s.repo, ["worktree", "add", "-q", "-b", "plain", "--", plain, base]);
    let diffs = compareCheckouts(wt, plain);
    // Again, now that the first clone has recorded what it proved.
    if (diffs.length === 0 && s.intn(3) === 0) {
      s.log.push(`clone ${base} again`);
      const again = `${wt}-again`;
      git(s.repo, [
        "worktree",
        "add",
        "-q",
        "-b",
        "again",
        "--no-checkout",
        "--",
        again,
        base,
      ]);
      const second = await runtime.runPromise(
        Effect.result(service.clone(s.repo, again)),
      );
      assert.ok(
        Result.isSuccess(second),
        `seed ${seed}: second clone failed\n${s.log.join("\n")}`,
      );
      diffs = compareCheckouts(again, plain);
    }
    assert.deepEqual(
      diffs,
      [],
      `seed ${seed} differs:\n${diffs.join("\n")}\n--- scenario\n${s.log.join("\n")}\n--- ${base}\n${tryGit(s.repo, ["ls-tree", "-r", base]).out}`,
    );
  } finally {
    await runtime.dispose();
    unlock(dirname(s.repo));
    rmSync(dirname(s.repo), { recursive: true, force: true });
  }
}

describe("clone checkout, differentially", () => {
  for (let seed = first; seed < first + count; seed++) {
    it(
      `matches a plain checkout, seed ${seed}`,
      () => runScenario(seed),
      60_000,
    );
  }
});
