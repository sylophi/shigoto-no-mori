// Throwaway repositories for the tests that run real git, and the Git
// service over the real platform to run against them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll } from "vitest";
import * as Git from "../../src/Git.ts";
import {
  GIT_IDENTITY,
  isolateGit,
  repositoryRoot,
} from "../../../../gitIsolation.ts";

// The service runs git under this process's environment. A pre-commit
// hook's GIT_* variables would point it at the commit in progress, and
// the user's own config would leak in, so both go before any test
// runs. Commits need an identity.
isolateGit();
Object.assign(process.env, GIT_IDENTITY);

const scratch = mkdtempSync(join(tmpdir(), "engine-git-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

export const tempDir = (prefix = "t-"): string =>
  mkdtempSync(join(scratch, prefix));

// git in a sandbox, outside the service, for setting up and looking.
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });

export const write = (
  dir: string,
  path: string,
  text: string | Uint8Array,
): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

export const rev = (repo: string, ref: string): string =>
  git(repo, "rev-parse", ref).trim();

// A clone of this repository at the commit checked out, shaped like a
// user's project: main tracking origin/main, origin the checkout it
// came from. Its own commit, not a pinned one: CI's checkout is
// shallow and holds no other.
export function realClone(dir = tempDir("real-")): string {
  const head = rev(repositoryRoot, "HEAD");
  const repo = join(dir, "shigoto-no-mori");
  git(dir, "clone", "-q", "--shared", "--no-checkout", repositoryRoot, repo);
  git(repo, "update-ref", "refs/remotes/origin/main", head);
  git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  git(repo, "checkout", "-q", "-B", "main", "--track", "origin/main");
  return repo;
}

// A repository on main with one commit holding a.txt, b.txt and
// dir/c.txt.
export function seedRepo(dir = tempDir("repo-")): string {
  git(dir, "init", "-q", "-b", "main");
  write(dir, "a.txt", "one\ntwo\nthree\n");
  write(dir, "b.txt", "bee\n");
  write(dir, "dir/c.txt", "sea\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const layer = Git.layer.pipe(Layer.provide(NodeServices.layer));

// Runs `body` against the service.
export const withGit = <A, E>(
  body: (git: Git.Git["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Git.Git);
    }).pipe(Effect.provide(layer)),
  );

// The failure `body` ends in, which must be a `cls`.
export const failureAs = async <T, A, E>(
  cls: abstract new (...args: never) => T,
  body: (git: Git.Git["Service"]) => Effect.Effect<A, E>,
): Promise<T> => {
  const error = await failureOf(body);
  assert.ok(error instanceof cls, String(error));
  return error;
};

// The failure `body` ends in, or a test failure when it succeeds.
export const failureOf = <A, E>(
  body: (git: Git.Git["Service"]) => Effect.Effect<A, E>,
): Promise<E> => withGit((service) => Effect.flip(body(service)));
