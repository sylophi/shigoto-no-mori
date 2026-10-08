// What the clone checkout's tests share: the service over real git and
// the real darwin helper, throwaway repos, and the comparison of a clone
// against the plain checkout beside it.
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as CloneCheckout from "../../src/CloneCheckout.ts";
import * as Darwin from "../../src/Darwin.ts";
import * as Git from "../../src/Git.ts";
import * as Paths from "../../src/Paths.ts";
import { nodeStore } from "./nodeStore.ts";
import { macfs } from "./sandbox.ts";

// Commits need an identity and fixed dates. The sandbox module this
// imports has already kept git's variables and the user's config out.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2005-04-07T22:13:13+0000",
  GIT_COMMITTER_DATE: "2005-04-07T22:13:13+0000",
});

// An old time, as a checkout that has sat for a while has, so a clone
// (which keeps it) is told apart from a git write (now).
export const FIXTURE_TIME = new Date("2020-01-02T03:04:05Z");

export const scratch = (prefix: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// git in `cwd`, answering its stdout, failing with its stderr.
export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, LC_ALL: "C", ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

// git that may fail, answering whether it did.
export const tryGit = (
  cwd: string,
  args: ReadonlyArray<string>,
): { readonly ok: boolean; readonly out: string; readonly err: string } => {
  try {
    return { ok: true, out: git(cwd, args), err: "" };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
};

export const write = (file: string, content: string, mode = 0o644) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, { mode });
};

// A repo on main with an empty first commit.
export const seedRepo = (parent: string, name = "repo") => {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
};

// The service over real git, the darwin helper and a store of its own.
// `darwin` stands in for the helper's service, to act mid-clone.
export const cloneRuntime = (
  darwin?: (real: Darwin.Darwin["Service"]) => Darwin.Darwin["Service"],
) => {
  const helper = Darwin.layer(macfs());
  const darwinLayer =
    darwin === undefined
      ? helper
      : Layer.effect(
          Darwin.Darwin,
          Effect.map(Effect.service(Darwin.Darwin), darwin),
        ).pipe(Layer.provide(helper));
  return ManagedRuntime.make(
    CloneCheckout.layer.pipe(
      Layer.provideMerge(Git.layer),
      Layer.provide(darwinLayer),
      Layer.provide(nodeStore),
      Layer.provide(Paths.layer("dev")),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              HOME: scratch("clone-home-"),
              PATH: process.env.PATH ?? "",
              SHIGOMORI_DATA_DIR: scratch("clone-data-"),
            },
          }),
        ),
      ),
    ),
  );
};

// A Darwin whose clone runs `before` once, ahead of the first clone.
export const beforeFirstClone =
  (before: () => void) =>
  (real: Darwin.Darwin["Service"]): Darwin.Darwin["Service"] => {
    let done = false;
    return {
      ...real,
      clone: (input) =>
        Stream.unwrap(
          Effect.sync(() => {
            if (!done) {
              done = true;
              before();
            }
            return real.clone(input);
          }),
        ),
    };
  };

// Everything on disk in a worktree but its .git link: kind, permissions,
// and content or link target, per path.
function worktreeContents(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const child = rel === "" ? name : `${rel}/${name}`;
      if (child === ".git") continue;
      const full = join(root, child);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        files.set(child, `link ${readlinkSync(full)}`);
      } else if (info.isDirectory()) {
        files.set(`${child}/`, `dir ${(info.mode & 0o777).toString(8)}`);
        walk(child);
      } else {
        files.set(
          child,
          `${(info.mode & 0o777).toString(8)} ${readFileSync(full, "latin1")}`,
        );
      }
    }
  };
  walk("");
  return files;
}

const clip = (text: string | undefined) =>
  text !== undefined && text.length > 60 ? `${text.slice(0, 60)}…` : text;

// Every way a clone can differ from the plain checkout beside it.
export function compareCheckouts(clone: string, plain: string): string[] {
  const diffs: string[] = [];
  const want = worktreeContents(plain);
  const got = worktreeContents(clone);
  for (const p of [...new Set([...want.keys(), ...got.keys()])].toSorted()) {
    if (want.get(p) !== got.get(p)) {
      diffs.push(
        `${p}: clone ${JSON.stringify(clip(got.get(p)))}, plain ${JSON.stringify(clip(want.get(p)))}`,
      );
    }
  }
  const index = (dir: string) => tryGit(dir, ["ls-files", "-s"]).out;
  if (index(plain) !== index(clone)) {
    diffs.push(
      `git ls-files -s:\nclone ${JSON.stringify(index(clone))}\nplain ${JSON.stringify(index(plain))}`,
    );
  }
  // A committed blob its own attributes wouldn't produce reads as
  // modified only when git looks at its bytes, which it does for a file
  // written within the second its index was and not otherwise. That one
  // status line is down to timing, on either side. The bytes are held
  // equal above.
  const unnormalized = (p: string) => {
    const oid = tryGit(plain, ["rev-parse", `HEAD:${p}`]);
    const cleaned = tryGit(plain, [
      "hash-object",
      "--path",
      p,
      "--",
      join(plain, p),
    ]);
    return oid.ok && cleaned.ok && oid.out.trim() !== cleaned.out.trim();
  };
  // What git status says, or how it fails: plain git can refuse a tree
  // too, and the clone has to refuse it the same way.
  const status = (dir: string) => {
    const run = tryGit(dir, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--ignored",
    ]);
    const kept = run.out
      .split("\0")
      .filter(
        (record) =>
          !(
            record.length > 3 &&
            record.startsWith(" M ") &&
            unnormalized(record.slice(3))
          ),
      );
    if (!run.ok) kept.push(`error: ${run.err.replaceAll(dir, "WORKTREE")}`);
    return kept.join("\n");
  };
  const [plainStatus, cloneStatus] = [status(plain), status(clone)];
  if (plainStatus !== cloneStatus) {
    diffs.push(
      `git status:\nclone ${JSON.stringify(cloneStatus)}\nplain ${JSON.stringify(plainStatus)}`,
    );
  }
  return diffs;
}
