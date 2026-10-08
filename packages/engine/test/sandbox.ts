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
import * as Git from "../src/Git.ts";

// The service runs git under this process's environment. A pre-commit
// hook's GIT_* variables would point it at the commit in progress, and
// the user's own config would leak in, so both go before any test
// runs. Commits need an identity.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

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
