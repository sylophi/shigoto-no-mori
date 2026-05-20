// Seeds a destination directory with a tree of throwaway git repos that
// exercise every state surface in Shigoto no Mori's UI:
//   - package-manager detection (bun / pnpm / yarn / npm / none)
//   - ahead / behind / dirty / detached / unknown-branch worktrees
//   - remotes (one, none, multiple) and default-branch resolution
//   - external (non-managed) worktrees and occupied branches
//   - gitignored carry-over candidates
//   - path shapes (spaces, unicode, deeply nested)
//
// Run:   pnpm seed <dest-dir> [--keep]
// The destination directory is required so worktree `.git` pointers are
// always self-contained at the chosen location — previously hard-coding
// /tmp/shigomori-seed meant a second seeding could cross-link external
// worktrees with the first repo's `.git` admin. Wipes <dest-dir> by
// default; --keep skips the wipe.
//
// The script does NOT touch ~/shigomori-dev/. Add each repo via the app.

import { execFile } from "node:child_process";
import { appendFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Filled in by main() before any seeder runs.
let ROOT = "";
let REPOS = "";
let REMOTES = "";
let EXTERNAL = "";
let SIDECAR = "";

interface Manifest {
  name: string;
  path: string;
  purpose: string;
  tests: string[];
}

// Deterministic identity so commits don't depend on the host's git config.
const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Seed Bot",
  GIT_AUTHOR_EMAIL: "seed@example.com",
  GIT_COMMITTER_NAME: "Seed Bot",
  GIT_COMMITTER_EMAIL: "seed@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function writeAt(
  repo: string,
  rel: string,
  content: string,
): Promise<void> {
  const full = join(repo, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function initRepo(path: string, defaultBranch = "main"): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", defaultBranch, "-q"]);
  await git(path, ["config", "user.name", "Seed Bot"]);
  await git(path, ["config", "user.email", "seed@example.com"]);
  await git(path, ["config", "commit.gpgsign", "false"]);
  await git(path, ["config", "tag.gpgsign", "false"]);
}

async function commit(
  repo: string,
  files: Record<string, string>,
  message: string,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([rel, content]) => writeAt(repo, rel, content)),
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message, "-q"]);
}

async function bareRemote(
  name: string,
  defaultBranch = "main",
): Promise<string> {
  await mkdir(REMOTES, { recursive: true });
  await git(REMOTES, [
    "init",
    "--bare",
    "-b",
    defaultBranch,
    "-q",
    `${name}.git`,
  ]);
  return join(REMOTES, `${name}.git`);
}

function pkgJson(name: string, scripts: Record<string, string>): string {
  return (
    JSON.stringify(
      { name, private: true, version: "0.0.0", scripts },
      null,
      2,
    ) + "\n"
  );
}

// ─── Archetypes ───────────────────────────────────────────────────────────

async function seedBunBasic(): Promise<Manifest> {
  const repo = join(REPOS, "bun-basic");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# bun-basic\n\nRich bun project for manual testing.\n",
      ".gitignore":
        ".env\n.env.local\nnode_modules/\n.vscode/\n.idea/\n*.log\nsecrets.json\nbuild/\n",
      "package.json": pkgJson("bun-basic", {
        dev: "echo 'dev server starting...' && sleep 3600",
        start: "echo 'started' && sleep 1 && echo 'done'",
        test: "echo 'running tests...' && sleep 1 && echo 'PASS  5 tests passed'",
        lint: "echo 'linting...' && sleep 0.5 && echo 'errors found' >&2 && exit 1",
        build:
          "for i in 1 2 3 4 5; do echo \"step $i\"; sleep 0.4; done && echo 'built'",
        colorful:
          "printf '\\033[31mred\\033[0m \\033[32mgreen\\033[0m \\033[33myellow\\033[0m \\033[34mblue\\033[0m\\n'",
        "tree-spawn": "sleep 999 & sleep 999 & sleep 999 & wait",
      }),
      // packageScripts.ts treats either bun.lockb or bun.lock as the bun signal.
      "bun.lock": "# bun lockfile placeholder\n",
      "src/index.ts": "export const greet = (n: string) => `Hello ${n}`;\n",
    },
    "Initial scaffold",
  );
  // Gitignored carry-over candidates.
  await writeAt(
    repo,
    ".env",
    "API_KEY=test-key\nDB_URL=postgres://localhost/dev\n",
  );
  await writeAt(repo, ".env.local", "OVERRIDE=true\n");
  await writeAt(
    repo,
    ".vscode/settings.json",
    `${JSON.stringify({ "editor.formatOnSave": true }, null, 2)}\n`,
  );
  await writeAt(
    repo,
    "node_modules/placeholder/package.json",
    `${JSON.stringify({ name: "placeholder", version: "0.0.0" })}\n`,
  );
  return {
    name: "bun-basic",
    path: repo,
    purpose:
      "Bun project with rich scripts and gitignored carry-over candidates",
    tests: [
      "Package Scripts row should say 'bun' and list 7 scripts.",
      "Run each script: colors render (colorful), failure surfaces with exit 1 (lint), long-running cancels cleanly (dev), tree-spawn cancel kills all 3 sleeps.",
      "Carry-over picker should list .env, .env.local, .vscode/, node_modules/. Pick a couple in different modes and confirm they show up in a new worktree.",
    ],
  };
}

async function seedPnpmWorkspaces(): Promise<Manifest> {
  const repo = join(REPOS, "pnpm-workspaces");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# pnpm-workspaces\n",
      ".gitignore": "node_modules/\n",
      "package.json": pkgJson("pnpm-workspaces", {
        build: "echo 'building all'",
        clean: "echo 'cleaning'",
      }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "packages/foo/package.json": `${JSON.stringify({ name: "@ws/foo", version: "0.0.0" }, null, 2)}\n`,
      "packages/foo/index.js": "module.exports = 'foo';\n",
    },
    "Initial workspaces",
  );
  return {
    name: "pnpm-workspaces",
    path: repo,
    purpose: "pnpm workspaces — should detect packageManager: pnpm",
    tests: ["Package Scripts row says 'pnpm' and lists build + clean."],
  };
}

async function seedYarnClassic(): Promise<Manifest> {
  const repo = join(REPOS, "yarn-classic");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# yarn-classic\n",
      "package.json": pkgJson("yarn-classic", {
        hello: "echo 'hi from yarn'",
      }),
      "yarn.lock":
        "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n",
    },
    "Initial",
  );
  return {
    name: "yarn-classic",
    path: repo,
    purpose: "yarn.lock present — should detect packageManager: yarn",
    tests: ["Package Scripts row says 'yarn'."],
  };
}

async function seedNpmVanilla(): Promise<Manifest> {
  const repo = join(REPOS, "npm-vanilla");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# npm-vanilla\n",
      "package.json": pkgJson("npm-vanilla", { hello: "echo 'hi from npm'" }),
    },
    "Initial",
  );
  return {
    name: "npm-vanilla",
    path: repo,
    purpose: "No lockfile — falls back to packageManager: npm",
    tests: ["Package Scripts row says 'npm'."],
  };
}

async function seedNoPackageJson(): Promise<Manifest> {
  const repo = join(REPOS, "no-package-json");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# no-package-json\n\nPlain repo with no Node.js metadata.\n",
      "src/main.go": "package main\n\nfunc main() {}\n",
    },
    "Initial",
  );
  return {
    name: "no-package-json",
    path: repo,
    purpose: "Repo without package.json",
    tests: [
      "Package Scripts section should hide or show its empty state cleanly.",
    ],
  };
}

async function seedWithOrigin(): Promise<Manifest> {
  const remote = await bareRemote("with-origin");
  const repo = join(REPOS, "with-origin");
  await initRepo(repo);
  await commit(
    repo,
    { "README.md": "# with-origin\n", "main.txt": "alpha\n" },
    "Initial",
  );
  await commit(repo, { "main.txt": "alpha\nbeta\n" }, "Second commit");
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);
  return {
    name: "with-origin",
    path: repo,
    purpose: "Wired to a fake bare remote; main is in sync with origin/main",
    tests: [
      "Ahead/behind shows 0/0.",
      "New Worktree from `origin/main` should auto-create a local tracking branch.",
      "Manage Branches lists `origin/main` alongside locals.",
    ],
  };
}

async function seedNoRemote(): Promise<Manifest> {
  const repo = join(REPOS, "no-remote");
  await initRepo(repo);
  await commit(
    repo,
    { "README.md": "# no-remote\n", "notes.txt": "local only\n" },
    "Initial",
  );
  await commit(repo, { "notes.txt": "local only\nupdate\n" }, "More notes");
  return {
    name: "no-remote",
    path: repo,
    purpose: "Single local branch, no remote configured",
    tests: [
      "Ahead/behind stays 0/0 (no upstream to compare).",
      "resolveDefaultBranch should fall back to local `main`.",
    ],
  };
}

async function seedMultiRemote(): Promise<Manifest> {
  const remoteA = await bareRemote("multi-remote-a");
  const remoteB = await bareRemote("multi-remote-b");
  const repo = join(REPOS, "multi-remote");
  await initRepo(repo);
  await commit(repo, { "README.md": "# multi-remote\n" }, "Initial");
  await git(repo, ["remote", "add", "alpha", remoteA]);
  await git(repo, ["remote", "add", "beta", remoteB]);
  await git(repo, ["push", "-u", "alpha", "main", "-q"]);
  await git(repo, ["push", "beta", "main", "-q"]);
  return {
    name: "multi-remote",
    path: repo,
    purpose: "Two remotes (alpha, beta), both with main pushed",
    tests: [
      "Manage Branches lists `alpha/main` and `beta/main`.",
      "resolveDefaultBranch picks the first remote's main per listRemotes order.",
    ],
  };
}

async function seedNonStandardDefault(): Promise<Manifest> {
  const repo = join(REPOS, "non-standard-default");
  await initRepo(repo, "trunk");
  await commit(
    repo,
    { "README.md": "# trunk-default\n\nOnly branch is `trunk`.\n" },
    "Initial",
  );
  return {
    name: "non-standard-default",
    path: repo,
    purpose: "Only a `trunk` branch (no main/master/dev)",
    tests: [
      "Adding the project should detect `trunk` as the default branch (first local fallback).",
      "Configure → Default branch should show `trunk` selectable.",
    ],
  };
}

async function seedAheadBehind(): Promise<Manifest> {
  const remote = await bareRemote("ahead-behind-divergent");
  const repo = join(REPOS, "ahead-behind-divergent");
  await initRepo(repo);
  await commit(repo, { "main.txt": "base\n" }, "Base commit");
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);

  // Simulate "someone else pushed" by cloning the bare, committing, pushing back.
  const sidecar = join(SIDECAR, "ahead-behind");
  await mkdir(SIDECAR, { recursive: true });
  await git(SIDECAR, ["clone", remote, "ahead-behind", "-q"]);
  await git(sidecar, ["config", "user.name", "Other Dev"]);
  await git(sidecar, ["config", "user.email", "other@example.com"]);
  await commit(sidecar, { "remote.txt": "from elsewhere\n" }, "Other's commit");
  await git(sidecar, ["push", "origin", "main", "-q"]);

  // Local diverges: one ahead (own commit), one behind (the sidecar push).
  // Different files on each side, so merge-tree reports a clean merge.
  await commit(repo, { "local.txt": "local change\n" }, "Local commit");
  await git(repo, ["fetch", "origin", "-q"]);
  return {
    name: "ahead-behind-divergent",
    path: repo,
    purpose: "Diverged 1/1 with non-overlapping changes — clean rebase path",
    tests: [
      "Sidebar shows the indigo ↑1/↓1 indicator.",
      "Detail header shows 'Pull and push ↑1↓1' (indigo). Clicking rebases (no merge commit lands) and then pushes; pill clears.",
      "`git log --oneline` should show linear history after.",
    ],
  };
}

async function seedDivergedRebaseConflict(): Promise<Manifest> {
  const remote = await bareRemote("diverged-rebase-conflict");
  const repo = join(REPOS, "diverged-rebase-conflict");
  await initRepo(repo);
  await commit(repo, { "foo.txt": "line1\nline2\nline3\n" }, "Base");
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);

  // Remote changes line 2 to "REMOTE".
  const sidecar = join(SIDECAR, "diverged-rebase-conflict");
  await mkdir(SIDECAR, { recursive: true });
  await git(SIDECAR, ["clone", remote, "diverged-rebase-conflict", "-q"]);
  await git(sidecar, ["config", "user.name", "Other Dev"]);
  await git(sidecar, ["config", "user.email", "other@example.com"]);
  await commit(
    sidecar,
    { "foo.txt": "line1\nREMOTE\nline3\n" },
    "Remote sets line 2 to REMOTE",
  );
  await git(sidecar, ["push", "origin", "main", "-q"]);

  // Local: commit B changes line 2 to "local-B", commit C lands on
  // "REMOTE" (matching remote's end state). Final tree matches remote
  // -> merge-tree clean. But rebasing B onto the remote tip will try to
  // replace "2" with "local-B" and find "REMOTE" instead -> conflict.
  await commit(
    repo,
    { "foo.txt": "line1\nlocal-B\nline3\n" },
    "Local B sets line 2 to local-B",
  );
  await commit(
    repo,
    { "foo.txt": "line1\nREMOTE\nline3\n" },
    "Local C lands on REMOTE",
  );
  await git(repo, ["fetch", "origin", "-q"]);
  return {
    name: "diverged-rebase-conflict",
    path: repo,
    purpose:
      "Final-tree merge is clean, but per-commit rebase conflicts on the intermediate state",
    tests: [
      "Sidebar shows the indigo ↑2/↓1 indicator (merge-tree probe is clean).",
      "Detail header shows 'Pull and push ↑2↓1' (indigo). Clicking attempts a rebase, hits a conflict on commit B, aborts, then falls back to a merge.",
      "`git log --oneline` should show a merge commit afterward (not linear).",
    ],
  };
}

async function seedAheadOnly(): Promise<Manifest> {
  const remote = await bareRemote("ahead-only");
  const repo = join(REPOS, "ahead-only");
  await initRepo(repo);
  await commit(
    repo,
    { "README.md": "# ahead-only\n", "log.txt": "line 1\n" },
    "Base",
  );
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);
  await commit(repo, { "log.txt": "line 1\nline 2\n" }, "Add line 2");
  await commit(repo, { "log.txt": "line 1\nline 2\nline 3\n" }, "Add line 3");
  return {
    name: "ahead-only",
    path: repo,
    purpose: "Local main has two unpushed commits",
    tests: [
      "Sidebar shows the emerald ↑2 indicator.",
      "Detail header shows 'Push 2 commits' (emerald). Clicking pushes; the pill clears.",
    ],
  };
}

async function seedBehindOnly(): Promise<Manifest> {
  const remote = await bareRemote("behind-only");
  const repo = join(REPOS, "behind-only");
  await initRepo(repo);
  await commit(
    repo,
    { "README.md": "# behind-only\n", "log.txt": "line 1\n" },
    "Base",
  );
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);
  // Sidecar pushes two commits that the local repo doesn't have.
  const sidecar = join(SIDECAR, "behind-only");
  await mkdir(SIDECAR, { recursive: true });
  await git(SIDECAR, ["clone", remote, "behind-only", "-q"]);
  await git(sidecar, ["config", "user.name", "Other Dev"]);
  await git(sidecar, ["config", "user.email", "other@example.com"]);
  await commit(
    sidecar,
    { "log.txt": "line 1\nremote line 2\n" },
    "Remote line 2",
  );
  await commit(
    sidecar,
    { "log.txt": "line 1\nremote line 2\nremote line 3\n" },
    "Remote line 3",
  );
  await git(sidecar, ["push", "origin", "main", "-q"]);
  // Fetch so @{u} reflects the remote tip without merging.
  await git(repo, ["fetch", "origin", "-q"]);
  return {
    name: "behind-only",
    path: repo,
    purpose: "Remote main has two commits the local doesn't",
    tests: [
      "Sidebar shows the sky ↓2 indicator.",
      "Detail header shows 'Pull 2 commits' (sky). Clicking fast-forwards and the pill clears.",
    ],
  };
}

async function seedUnpublishedBranch(): Promise<Manifest> {
  const remote = await bareRemote("unpublished-branch");
  const repo = join(REPOS, "unpublished-branch");
  await initRepo(repo);
  await commit(repo, { "README.md": "# unpublished-branch\n" }, "Initial");
  // Remote is wired up, but main is never pushed -- no upstream is set.
  await git(repo, ["remote", "add", "origin", remote]);
  return {
    name: "unpublished-branch",
    path: repo,
    purpose: "Remote configured but `main` was never pushed (no upstream)",
    tests: [
      "Sidebar shows the violet cloud-upload icon.",
      "Detail header shows 'Publish' (violet, enabled). Clicking runs `git push -u origin HEAD` and the pill clears.",
    ],
  };
}

async function seedDivergedConflicts(): Promise<Manifest> {
  const remote = await bareRemote("diverged-conflicts");
  const repo = join(REPOS, "diverged-conflicts");
  await initRepo(repo);
  await commit(repo, { "shared.txt": "alpha\nbeta\ngamma\n" }, "Base");
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);

  // Sidecar rewrites the middle line; local rewrites the same line
  // differently. merge-tree will report a conflict.
  const sidecar = join(SIDECAR, "diverged-conflicts");
  await mkdir(SIDECAR, { recursive: true });
  await git(SIDECAR, ["clone", remote, "diverged-conflicts", "-q"]);
  await git(sidecar, ["config", "user.name", "Other Dev"]);
  await git(sidecar, ["config", "user.email", "other@example.com"]);
  await commit(
    sidecar,
    { "shared.txt": "alpha\nBETA from remote\ngamma\n" },
    "Remote rewrites middle line",
  );
  await git(sidecar, ["push", "origin", "main", "-q"]);

  await commit(
    repo,
    { "shared.txt": "alpha\nBETA from local\ngamma\n" },
    "Local rewrites middle line",
  );
  await git(repo, ["fetch", "origin", "-q"]);
  return {
    name: "diverged-conflicts",
    path: repo,
    purpose:
      "Diverged 1/1 with overlapping edits on `shared.txt` — merge-tree fails",
    tests: [
      "Sidebar shows the rose diverged indicator (1/1).",
      "Detail header shows the rose trio [Overwrite | Push 1 | Pull 1].",
      "  - Overwrite discards the local edit and snaps to the remote line.",
      "  - Push 1 force-pushes; the sidecar's commit is dropped from the remote.",
      "  - Pull 1 (rebase) surfaces a conflict in the terminal; the rebase stops mid-flight.",
    ],
  };
}

async function seedManyBranches(): Promise<Manifest> {
  const repo = join(REPOS, "many-branches");
  await initRepo(repo);
  await commit(repo, { "README.md": "# many-branches\n" }, "Initial");

  const branches = [
    "feat/auth",
    "feat/billing",
    "feat/dashboard",
    "feat/onboarding",
    "feat/search",
    "feat/notifications",
    "feat/profile",
    "feat/settings",
    "fix/login-bug",
    "fix/typo-readme",
    "fix/race-condition",
    "fix/memory-leak",
    "fix/regression-from-pr-1234",
    "release/0.1.0",
    "release/0.2.0",
    "release/1.0.0",
    "release/2.0.0",
    "chore/deps",
    "chore/lint",
    "chore/typecheck",
    "experiment/agentic-flow",
    "experiment/llm-rewrite",
    "spike/perf-bench",
    "wip/draft",
    "feat/日本語ブランチ",
    "feat/extremely-long-branch-name-to-test-truncation-behavior-in-pickers-and-elsewhere-where-paths-might-get-clipped",
    "old/2021-cleanup",
    "old/abandoned",
    "main-backup",
  ];
  for (const branch of branches) {
    // oxlint-disable-next-line no-await-in-loop -- serialize to avoid races on .git/packed-refs
    await git(repo, ["branch", branch]);
  }
  // Occupy `feat/auth` via an external worktree so the New Worktree picker hides it.
  const occupied = join(EXTERNAL, "many-branches-occupant");
  await mkdir(EXTERNAL, { recursive: true });
  await git(repo, ["worktree", "add", occupied, "feat/auth"]);
  return {
    name: "many-branches",
    path: repo,
    purpose: "30+ branches; one occupied by an external worktree",
    tests: [
      "Branch combobox lists everything; fuzzy search narrows fast.",
      "New Worktree → 'Check out source' hides `feat/auth` (occupied elsewhere).",
      "Long branch name truncates with ellipsis; unicode branch renders.",
      "Manage Branches lets you delete a non-current branch.",
    ],
  };
}

async function seedDirtyPrimary(): Promise<Manifest> {
  const repo = join(REPOS, "dirty-primary");
  await initRepo(repo);
  await commit(repo, { "tracked.txt": "v1\n" }, "Initial");
  // One modified tracked + one untracked file → changedCount === 2.
  await writeAt(repo, "tracked.txt", "v1\nlocal edits\n");
  await writeAt(repo, "scratch.txt", "untracked\n");
  return {
    name: "dirty-primary",
    path: repo,
    purpose: "Primary checkout has 1 modified + 1 untracked file",
    tests: [
      "Sidebar shows uncommitted-changes indicator on the primary row.",
      "Attempting to delete the primary worktree should be rejected.",
    ],
  };
}

async function seedPreExistingWorktrees(): Promise<Manifest> {
  const repo = join(REPOS, "pre-existing-worktrees");
  await initRepo(repo);
  await commit(repo, { "README.md": "# pre-existing-worktrees\n" }, "Initial");
  await commit(repo, { "second.txt": "more\n" }, "Second commit");
  await mkdir(EXTERNAL, { recursive: true });
  await git(repo, [
    "worktree",
    "add",
    join(EXTERNAL, "pre-existing-feat"),
    "-b",
    "feat/external-one",
  ]);
  await git(repo, [
    "worktree",
    "add",
    "--detach",
    join(EXTERNAL, "pre-existing-detached"),
    "HEAD",
  ]);
  return {
    name: "pre-existing-worktrees",
    path: repo,
    purpose: "Two worktrees pre-created outside ~/shigomori-dev/worktrees/",
    tests: [
      "Sidebar lists primary + 2 extra worktrees tagged External.",
      "Detached worktree shows the short SHA / detached state, not a branch.",
    ],
  };
}

async function seedConvertibleExternals(): Promise<Manifest> {
  const remote = await bareRemote("convertible-externals");
  const repo = join(REPOS, "convertible-externals");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# convertible-externals\n\nFive externals exercising the 'Convert external worktrees' flow.\n",
      ".gitignore": ".env\n.env.local\n.vscode/\nnode_modules/\n*.log\n",
      "package.json": pkgJson("convertible-externals", {
        setup: "echo 'setup ran for' \"$SHIGOMORI_WORKTREE_NAME\"",
        dev: "echo 'dev' && sleep 3600",
      }),
      "src/index.ts": "export {};\n",
    },
    "Initial",
  );
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);

  // Gitignored carry-over candidates so post-conversion we can confirm the
  // managed worktree got a fresh ones (or symlinks) instead of the old
  // external's copies.
  await writeAt(
    repo,
    ".env",
    "FAKE_API_KEY=primary\nFAKE_DB_URL=postgres://localhost/primary\n",
  );
  await writeAt(
    repo,
    ".vscode/settings.json",
    '{"editor.formatOnSave":true}\n',
  );

  // Branch with a slash — slugified into a hyphenated dir name.
  await git(repo, ["branch", "feat/auth-flow"]);
  // Unicode branch — should round-trip through sanitizeBranchForPath.
  await git(repo, ["branch", "feat/日本語ブランチ"]);
  // Long branch — should still produce a usable dir name.
  await git(repo, [
    "branch",
    "experiment/extremely-long-branch-name-to-stress-the-managed-path-preview-and-confirm-no-overflow",
  ]);
  // Branch with a remote upstream so the converted worktree should retain
  // the same ahead/behind story (0/0) right after conversion.
  await git(repo, ["branch", "release/1.0.0"]);
  await git(repo, ["push", "-u", "origin", "release/1.0.0", "-q"]);

  await mkdir(EXTERNAL, { recursive: true });
  const baseExternal = join(EXTERNAL, "convertible-externals");
  await mkdir(baseExternal, { recursive: true });

  // 1. Clean slashed branch.
  const cleanSlashed = join(baseExternal, "clean-slashed");
  await git(repo, ["worktree", "add", cleanSlashed, "feat/auth-flow"]);

  // 2. Dirty external — modified tracked file + untracked file. The convert
  //    flow's destructive warning should make clear this gets wiped.
  const dirty = join(baseExternal, "dirty-edits");
  await git(repo, [
    "worktree",
    "add",
    dirty,
    "experiment/extremely-long-branch-name-to-stress-the-managed-path-preview-and-confirm-no-overflow",
  ]);
  await writeAt(dirty, "src/index.ts", "export const local = 'edit';\n");
  await writeAt(dirty, "scratch.txt", "untracked work that will vanish\n");

  // 3. Unicode branch.
  const unicode = join(baseExternal, "unicode-branch");
  await git(repo, ["worktree", "add", unicode, "feat/日本語ブランチ"]);

  // 4. Detached HEAD at the initial commit so the resulting managed worktree
  //    stays detached at the same SHA.
  const detached = join(baseExternal, "pinned-commit");
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["worktree", "add", "--detach", detached, head]);

  // 5. Remote-backed branch (release/1.0.0). Useful for verifying upstream
  //    state survives the round-trip.
  const remoteBacked = join(baseExternal, "remote-backed");
  await git(repo, ["worktree", "add", remoteBacked, "release/1.0.0"]);

  return {
    name: "convertible-externals",
    path: repo,
    purpose:
      "Five external worktrees covering slashed, unicode, long, detached, and remote-backed branches for the Convert External flow",
    tests: [
      "Project dropdown → 'Convert external worktrees' lists all 5 externals (primary is excluded).",
      "Each row shows the old external path → new ~/shigomori-dev/worktrees/convertible-externals/<slug> path. Slashes become hyphens; the unicode branch keeps its characters; the long branch stays readable.",
      "The 'dirty-edits' row shows the amber 'N uncommitted' pill.",
      "The 'pinned-commit' row shows the 'detached' pill and the short SHA where a branch name would be.",
      "Select all → '5 of 5 selected' shows in the row above the list; the submit button just reads 'Convert'.",
      "Convert just the dirty one first: confirm the destructive banner copy, then run. Old directory disappears, new managed worktree at ~/shigomori-dev/worktrees/convertible-externals/<slug> exists, the in-flight edits and scratch.txt are gone.",
      "Convert the remaining four. Each succeeds; detached one stays detached at the same SHA; release/1.0.0 still tracks origin/release/1.0.0 (0/0).",
      "After all five convert, the page shows the empty state and the sidebar no longer marks any worktree as External.",
    ],
  };
}

async function seedCarryoverRich(): Promise<Manifest> {
  const repo = join(REPOS, "carryover-rich");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# carryover-rich\n",
      ".gitignore":
        ".env\n.env.local\n.vscode/\n.idea/\nnode_modules/\n*.log\nsecrets.json\nbuild/\n",
      "src/index.ts": "export {};\n",
    },
    "Initial",
  );
  await writeAt(
    repo,
    ".env",
    "FAKE_API_KEY=abc123\nFAKE_DB_URL=postgres://localhost\n",
  );
  await writeAt(repo, ".env.local", "DEV_OVERRIDE=true\n");
  await writeAt(
    repo,
    ".vscode/settings.json",
    `${JSON.stringify({ "editor.formatOnSave": true }, null, 2)}\n`,
  );
  await writeAt(
    repo,
    ".vscode/extensions.json",
    `${JSON.stringify({ recommendations: ["dbaeumer.vscode-eslint"] }, null, 2)}\n`,
  );
  await writeAt(
    repo,
    ".idea/workspace.xml",
    '<project version="4"></project>\n',
  );
  await writeAt(
    repo,
    "node_modules/some-pkg/package.json",
    `${JSON.stringify({ name: "some-pkg", version: "1.0.0" })}\n`,
  );
  await writeAt(
    repo,
    "node_modules/some-pkg/index.js",
    "module.exports = 'hi';\n",
  );
  await writeAt(repo, "secrets.json", '{"DO_NOT_COMMIT": true}\n');
  await writeAt(repo, "build/output.txt", "compiled artifact\n");
  await writeAt(repo, "debug.log", "debug log line\n");
  return {
    name: "carryover-rich",
    path: repo,
    purpose: "Many gitignored entries (files + dirs) for the carry-over picker",
    tests: [
      "Carry-over picker lists .env, .env.local, .vscode/, .idea/, node_modules/, secrets.json, build/, debug.log.",
      "Add some in Copy and some in Symlink; create a worktree and verify both modes apply.",
      "Delete .env on disk after configuring → next New Worktree page shows the 'missing' badge.",
    ],
  };
}

// Pre-built worktree with a symlink-mode carry-over of an untracked
// directory. Mirrors what `applyCarryOver` produces: the symlink itself
// plus a matching entry in the shared `.git/info/exclude` so git treats
// the path as ignored. Without the exclude line the symlink would surface
// as an untracked `?? shared-deps`, and `git diff --no-index` would
// blow up on the symlink-to-directory, leaving the diff body blank.
async function seedCarryoverSymlinkDir(): Promise<Manifest> {
  const repo = join(REPOS, "carryover-symlink-dir");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# carryover-symlink-dir\n",
      ".gitignore": "shared-deps/\n",
      "src/index.ts": "export {};\n",
    },
    "Initial",
  );
  await writeAt(repo, "shared-deps/lib/index.js", "module.exports = 1;\n");
  await writeAt(
    repo,
    "shared-deps/lib/package.json",
    `${JSON.stringify({ name: "lib", version: "1.0.0" })}\n`,
  );
  await mkdir(EXTERNAL, { recursive: true });
  const worktreePath = join(EXTERNAL, "carryover-symlink-dir-feat");
  await git(repo, ["worktree", "add", worktreePath, "-b", "feat/sym-repro"]);
  // Absolute target so the link survives moving the worktree dir, matching
  // what `applyCarryOver` would produce for a Symlink-mode entry.
  await symlink(join(repo, "shared-deps"), join(worktreePath, "shared-deps"));
  // Same `info/exclude` entry applyCarryOver writes -- leading slash anchors
  // the pattern to the worktree root, hides the symlink from git status.
  await appendFile(join(repo, ".git/info/exclude"), "/shared-deps\n");
  return {
    name: "carryover-symlink-dir",
    path: repo,
    purpose:
      "Pre-built worktree with a directory symlink carry-over (excluded via .git/info/exclude)",
    tests: [
      "Add project. Sidebar should show the primary plus a `feat/sym-repro` worktree (External).",
      "Open `feat/sym-repro`. Sync pill should report no uncommitted changes; Uncommitted changes view shows the empty state.",
      "To exercise the pre-fix bug: remove the `/shared-deps` line from `repos/carryover-symlink-dir/.git/info/exclude` -- count returns to 1 and the diff body is blank.",
    ],
  };
}

async function seedPathSpaces(): Promise<Manifest> {
  const repo = join(REPOS, "path with spaces");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# spaces in path\n",
      "package.json": pkgJson("path-with-spaces", {
        hello: "echo 'spaces ok'",
      }),
    },
    "Initial",
  );
  return {
    name: "path with spaces",
    path: repo,
    purpose: "Directory name contains spaces",
    tests: [
      "Add project — the path renders correctly throughout the UI.",
      "Run the `hello` script — confirm the cwd quoting holds end-to-end.",
    ],
  };
}

async function seedUnicodePath(): Promise<Manifest> {
  const repo = join(REPOS, "プロジェクト");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# プロジェクト\n\n日本語のディレクトリ名で動くか。\n",
      "package.json": pkgJson("unicode-path", {
        hello: "echo 'unicode ok'",
      }),
    },
    "Initial",
  );
  return {
    name: "プロジェクト",
    path: repo,
    purpose: "Unicode (Japanese) directory name",
    tests: [
      "The project name renders correctly in the sidebar and headers.",
      "Creating a worktree under it preserves the unicode segment in the worktree path.",
    ],
  };
}

async function seedDeeplyNested(): Promise<Manifest> {
  const repo = join(REPOS, "a/very/deep/nested/path/leaf-repo");
  await initRepo(repo);
  await commit(repo, { "README.md": "# deeply nested\n" }, "Initial");
  return {
    name: "leaf-repo (deeply nested)",
    path: repo,
    purpose: "Path is deeply nested to exercise truncation",
    tests: [
      "Sidebar shows abbreviated middle segments (full path on hover).",
      "Footer / detail headers render without overflow.",
    ],
  };
}

async function seedPortPoolBasic(): Promise<Manifest> {
  const repo = join(REPOS, "port-pool-basic");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# port-pool-basic\n\nValid port-pool.config.json with two ports written into a single .env.\n",
      ".gitignore": ".env\nnode_modules/\n",
      "package.json": pkgJson("port-pool-basic", {
        dev: 'echo "web=$PORT api=$API_PORT" && sleep 3600',
      }),
      "bun.lock": "# bun lockfile placeholder\n",
      "port-pool.config.json":
        JSON.stringify(
          {
            schemaVersion: 1,
            portNames: ["web", "api"],
            envFiles: {
              ".env": {
                PORT: "${web}",
                API_PORT: "${api}",
              },
            },
          },
          null,
          2,
        ) + "\n",
    },
    "Initial",
  );
  return {
    name: "port-pool-basic",
    path: repo,
    purpose: "Valid port-pool config with two ports and one .env file",
    tests: [
      "Toggle 'Automatically use port-pool' on in Settings.",
      "Create a worktree -- ScriptsSection shows Port-pool provision and Port-pool release rows.",
      "Provision runs at create. Check the new worktree's .env: PORT and API_PORT are populated.",
      "Run dev -- the echoed values match the .env.",
      "Delete the worktree -- Port-pool release runs before remove. Allocations dropped from `port-pool list`.",
      "Toggle off in Settings, then add the project again -- no Port-pool rows appear.",
    ],
  };
}

async function seedPortPoolMonorepo(): Promise<Manifest> {
  const repo = join(REPOS, "port-pool-monorepo");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# port-pool-monorepo\n\npnpm workspaces with port-pool at the root and env files in two packages.\n",
      ".gitignore": ".env\napps/*/.env\napps/*/.env.local\nnode_modules/\n",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "package.json": pkgJson("port-pool-monorepo", {
        dev: "echo 'run pnpm --filter web dev or pnpm --filter api dev'",
      }),
      "apps/web/package.json": `${JSON.stringify({ name: "@ws/web", version: "0.0.0", scripts: { dev: 'echo "web on $PORT api=$API_URL"' } }, null, 2)}\n`,
      "apps/api/package.json": `${JSON.stringify({ name: "@ws/api", version: "0.0.0", scripts: { dev: 'echo "api on $PORT db=$DATABASE_URL"' } }, null, 2)}\n`,
      "port-pool.config.json":
        JSON.stringify(
          {
            schemaVersion: 1,
            portNames: ["web", "api", "db"],
            envFiles: {
              ".env": {
                DB_PORT: "${db}",
              },
              "apps/web/.env.local": {
                PORT: "${web}",
                API_URL: "http://localhost:${api}",
              },
              "apps/api/.env": {
                PORT: "${api}",
                DATABASE_URL: "postgres://localhost:${db}/app",
              },
            },
          },
          null,
          2,
        ) + "\n",
    },
    "Initial",
  );
  return {
    name: "port-pool-monorepo",
    path: repo,
    purpose:
      "pnpm workspaces + port-pool managing three ports across three env files",
    tests: [
      "Create a worktree -- provision populates root .env plus apps/web/.env.local plus apps/api/.env.",
      "Verify the same ${api} value appears in apps/web/.env.local API_URL and apps/api/.env PORT.",
      "Lifecycle rows render in order: Setup (if configured), Port-pool provision, Port-pool release, Teardown (if configured).",
      "Delete worktree -- release runs first, then removeWorktree.",
    ],
  };
}

async function seedPortPoolInvalid(): Promise<Manifest> {
  const repo = join(REPOS, "port-pool-invalid-config");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# port-pool-invalid-config\n\nport-pool.config.json missing schemaVersion. Integration should detect as inactive.\n",
      "port-pool.config.json":
        JSON.stringify({ portNames: ["foo"] }, null, 2) + "\n",
    },
    "Initial",
  );
  return {
    name: "port-pool-invalid-config",
    path: repo,
    purpose:
      "port-pool.config.json without schemaVersion -- gate should reject",
    tests: [
      "Toggle 'Automatically use port-pool' on. Add this project.",
      "ScriptsSection shows NO Port-pool rows.",
      "Create a worktree -- provision does not run (no toast, no console entries).",
      "Confirms the loose schema check (schemaVersion field presence) is enforced.",
    ],
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────

async function writeReadme(manifests: Manifest[]): Promise<void> {
  const lines: string[] = [
    "# Shigoto no Mori — manual test seed",
    "",
    `Throwaway repos under \`${REPOS}/\`, each exercising a`,
    "different slice of the app. Add each one in the app and follow the",
    "checklist below.",
    "",
    "Regenerate any time with:",
    "",
    `    pnpm seed ${ROOT}`,
    "",
    "## Repos",
    "",
  ];
  for (const m of manifests) {
    lines.push(`### ${m.name}`);
    lines.push("");
    lines.push(`Path: \`${m.path}\``);
    lines.push("");
    lines.push(`Purpose: ${m.purpose}`);
    lines.push("");
    lines.push("What to test:");
    for (const t of m.tests) lines.push(`- ${t}`);
    lines.push("");
  }
  lines.push("## Supporting directories");
  lines.push("");
  lines.push("- `remotes/` — bare repos backing any repo with a real remote.");
  lines.push(
    "- `external/` — git worktrees pre-created outside the managed dir.",
  );
  lines.push("- `.sidecar/` — internal clones used to push divergent commits.");
  lines.push("");
  await writeFile(join(ROOT, "README.md"), `${lines.join("\n")}\n`);
}

function printSummary(manifests: Manifest[], elapsedMs: number): void {
  const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const green = (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);

  console.log("");
  console.log(
    green(
      `✓ Seeded ${manifests.length} repos in ${(elapsedMs / 1000).toFixed(1)}s`,
    ),
  );
  console.log("");
  for (const m of manifests) {
    console.log(`  ${m.path}`);
    console.log(`    ${dim(m.purpose)}`);
  }
  console.log("");
  console.log(`Manifest with test checklists: ${dim(join(ROOT, "README.md"))}`);
  console.log(`Next: launch the app and Add Project for each path above.`);
}

function usage(): never {
  console.error(
    "Usage: pnpm seed <dest-dir> [--keep]\n" +
      "\n" +
      "  <dest-dir>  Absolute or relative path where the seed tree will live.\n" +
      "              Required so worktree `.git` pointers stay self-contained.\n" +
      "  --keep      Skip wiping <dest-dir> before seeding.",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) usage();
  const dest = isAbsolute(positional[0])
    ? positional[0]
    : resolve(process.cwd(), positional[0]);

  ROOT = dest;
  REPOS = join(ROOT, "repos");
  REMOTES = join(ROOT, "remotes");
  EXTERNAL = join(ROOT, "external");
  SIDECAR = join(ROOT, ".sidecar");

  const started = Date.now();

  if (!keep) {
    await rm(ROOT, { recursive: true, force: true });
  }
  await mkdir(REPOS, { recursive: true });
  await mkdir(REMOTES, { recursive: true });

  // Seeders are independent; run them concurrently. allSettled so a single
  // failure doesn't hide the others.
  const seeders: Array<{ name: string; run: () => Promise<Manifest> }> = [
    { name: "bun-basic", run: seedBunBasic },
    { name: "pnpm-workspaces", run: seedPnpmWorkspaces },
    { name: "yarn-classic", run: seedYarnClassic },
    { name: "npm-vanilla", run: seedNpmVanilla },
    { name: "no-package-json", run: seedNoPackageJson },
    { name: "with-origin", run: seedWithOrigin },
    { name: "no-remote", run: seedNoRemote },
    { name: "multi-remote", run: seedMultiRemote },
    { name: "non-standard-default", run: seedNonStandardDefault },
    { name: "ahead-behind-divergent", run: seedAheadBehind },
    { name: "diverged-rebase-conflict", run: seedDivergedRebaseConflict },
    { name: "ahead-only", run: seedAheadOnly },
    { name: "behind-only", run: seedBehindOnly },
    { name: "unpublished-branch", run: seedUnpublishedBranch },
    { name: "diverged-conflicts", run: seedDivergedConflicts },
    { name: "many-branches", run: seedManyBranches },
    { name: "dirty-primary", run: seedDirtyPrimary },
    { name: "pre-existing-worktrees", run: seedPreExistingWorktrees },
    { name: "convertible-externals", run: seedConvertibleExternals },
    { name: "carryover-rich", run: seedCarryoverRich },
    { name: "carryover-symlink-dir", run: seedCarryoverSymlinkDir },
    { name: "path with spaces", run: seedPathSpaces },
    { name: "プロジェクト", run: seedUnicodePath },
    { name: "deeply-nested", run: seedDeeplyNested },
    { name: "port-pool-basic", run: seedPortPoolBasic },
    { name: "port-pool-monorepo", run: seedPortPoolMonorepo },
    { name: "port-pool-invalid-config", run: seedPortPoolInvalid },
  ];

  const results = await Promise.allSettled(seeders.map((s) => s.run()));
  const manifests: Manifest[] = [];
  const failures: Array<{ name: string; error: Error }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const s = seeders[i];
    if (r.status === "fulfilled") manifests.push(r.value);
    else
      failures.push({
        name: s.name,
        error:
          r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
      });
  }

  if (manifests.length > 0) await writeReadme(manifests);
  printSummary(manifests, Date.now() - started);

  if (failures.length > 0) {
    console.error("");
    console.error(`✖ ${failures.length} seeder(s) failed:`);
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error.message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✖ Seed failed:", err);
  process.exit(1);
});
