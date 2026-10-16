// The repo most walks start from: a short history with a long file and
// media (an image changed, a clip and a tone added), a bare origin it
// is pushed to, a branch with a commit of its own, a stash, and
// uncommitted changes of every kind. Dates are fixed, so hashes are too.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Lab, WALK_AUTHOR } from "./labApp.mts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export const LONG_LINES = 1500;

export function seedDemo(reposDir: string, git: Lab["git"]): string {
  const repo = join(reposDir, "demo");
  mkdirSync(repo, { recursive: true });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const media = (fixture: string, path: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), join(repo, path));
  };
  let day = 0;
  const commit = (subject: string) => {
    day += 1;
    const date = `2026-10-0${day}T10:00:00Z`;
    git(repo, "add", "-A");
    execFileSync("git", ["commit", "-q", "-m", subject], {
      cwd: repo,
      env: {
        PATH: process.env["PATH"],
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: WALK_AUTHOR.name,
        GIT_AUTHOR_EMAIL: WALK_AUTHOR.email,
        GIT_COMMITTER_NAME: WALK_AUTHOR.name,
        GIT_COMMITTER_EMAIL: WALK_AUTHOR.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  };

  git(repo, "init", "-q", "-b", "main");
  write(
    "package.json",
    `${JSON.stringify({ name: "demo", private: true, scripts: { hello: "echo hello from demo" } }, null, 2)}\n`,
  );
  write("README.md", "# Demo\n\nA repo for the walks.\n");
  write("src/app.ts", "export const greet = (n: string) => `hi ${n}`;\n");
  commit("Initial commit");
  write(
    "src/long.txt",
    Array.from({ length: LONG_LINES }, (_, i) => `line ${i + 1}\n`).join(""),
  );
  commit("Add a long file");
  media("logo-before.png", "media/logo.png");
  commit("Add the logo");
  media("logo-after.png", "media/logo.png");
  media("tone.mp3", "media/tone.mp3");
  media("clip.mp4", "media/clip.mp4");
  commit("Recolor the logo, add a tone and a clip");
  write(
    "src/app.ts",
    'export const greet = (n: string) => `hello ${n}`;\nexport const bye = () => "bye";\n',
  );
  write("NOTES.md", "notes\n");
  commit("Touch several files");

  const origin = join(reposDir, "origin.git");
  git(reposDir, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "-q", "-u", "origin/main");

  git(repo, "checkout", "-q", "-b", "feature/one");
  write("feature.txt", "feature\n");
  commit("Add the feature file");
  git(repo, "checkout", "-q", "main");

  write("README.md", "# Demo\n\nA repo for the walks.\nstashed change\n");
  git(repo, "stash", "push", "-q", "-m", "WIP on readme");

  write(
    "src/app.ts",
    'export const greet = (n: string) => `hey ${n}`;\nexport const bye = () => "bye";\n',
  );
  write("new-file.txt", "untracked\n");
  git(repo, "rm", "-q", "NOTES.md");
  media("logo-before.png", "media/logo.png");
  return repo;
}
