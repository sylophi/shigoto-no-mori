// Durable proof for starting a new project (projects:create): the
// payload schema's folder-name rule, and createRepo against REAL git
// for what the schema can't say: the repository lands where asked with
// a first commit on its default branch, a folder already there is never
// written over, and a start that fails leaves nothing behind.
//
// Runs under test/lib/register-ts-alias.mts so the app's TypeScript
// imports resolve. Run: pnpm test create-project.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

// createRepo runs git under this process's environment: the hook's
// GIT_* variables go (clone.mts says why), and an identity stands in
// for the user's config, which the scrub cuts off.
const IDENTITY = {
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
};
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv(IDENTITY);

const { createRepo } = await import("../host/lib/git/init.ts");
const { CreateProjectPayloadSchema } =
  await import("../shared/schemas/project.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("create-project proof");

// One config entry for the git createRepo runs, as the user's own
// config would set it, for the length of `fn`.
async function withGitConfig(
  key: string,
  value: string,
  fn: () => Promise<void>,
): Promise<void> {
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: value,
  });
  try {
    await fn();
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  }
}

async function main() {
  await check("the name is held to one path segment", () => {
    const accepts = (name: string) =>
      CreateProjectPayloadSchema.safeParse({ parentDir: "~/dev", name })
        .success;
    for (const name of ["repo", "my repo", "repo.v2", "-dash"]) {
      assert.ok(accepts(name), name);
    }
    for (const name of ["", "  ", ".", "..", "a/b", "../escape", "a\\b"]) {
      assert.ok(!accepts(name), name);
    }
  });

  await check(
    "a new repository lands where asked, one empty commit on main",
    async (track) => {
      const parent = tempDir("sm-create-", track);
      const dest = await createRepo(parent, "fresh");
      assert.equal(dest, join(parent, "fresh"));
      assert.equal(
        git(dest, "rev-parse", "--abbrev-ref", "HEAD").trim(),
        "main",
      );
      assert.equal(git(dest, "rev-list", "--count", "HEAD").trim(), "1");
      assert.equal(git(dest, "status", "--porcelain").trim(), "");
    },
  );

  await check("a configured default branch is kept", async (track) => {
    const parent = tempDir("sm-create-", track);
    await withGitConfig("init.defaultBranch", "trunk", async () => {
      const dest = await createRepo(parent, "fresh");
      assert.equal(
        git(dest, "rev-parse", "--abbrev-ref", "HEAD").trim(),
        "trunk",
      );
    });
  });

  await check(
    "a folder already there, or a parent that isn't, is left alone",
    async (track) => {
      const parent = tempDir("sm-create-", track);
      const taken = join(parent, "taken");
      mkdirSync(taken);
      writeFileSync(join(taken, "mine.txt"), "mine\n");
      await assert.rejects(createRepo(parent, "taken"), /already exists/);
      assert.ok(!existsSync(join(taken, ".git")));
      assert.ok(existsSync(join(taken, "mine.txt")));

      const missing = join(parent, "nowhere");
      await assert.rejects(createRepo(missing, "fresh"), /not a folder/);
      assert.ok(!existsSync(missing));
    },
  );

  await check(
    "a commit git refuses (no identity) leaves no folder behind",
    async (track) => {
      const parent = tempDir("sm-create-", track);
      for (const key of Object.keys(IDENTITY)) delete process.env[key];
      try {
        // Without this, git guesses an identity from the machine's
        // user and host names, and on most machines that works.
        await withGitConfig("user.useConfigOnly", "true", async () => {
          await assert.rejects(createRepo(parent, "fresh"));
        });
      } finally {
        Object.assign(process.env, IDENTITY);
      }
      assert.ok(!existsSync(join(parent, "fresh")));
    },
  );

  done();
}

main().catch(fail);
