// Seeds a destination directory with a tree of throwaway git repos that
// exercise every state surface in Shigoto no Mori's UI:
//   - package-manager detection (bun / pnpm / yarn / npm / none)
//   - ahead / behind / dirty / detached / unknown-branch worktrees
//   - remotes (one, none, multiple) and default-branch resolution
//   - external (non-managed) worktrees and occupied branches
//   - gitignored carry-over candidates
//   - path shapes (spaces, unicode, deeply nested)
//
// Run:   pnpm seed <dest-dir> [--keep] [--only=<name>[,<name>...]]
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
// Set for --only runs: recreate each selected seeder's repo and remote
// in place instead of relying on the full-tree wipe.
let RECREATE = false;

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
  content: string | Buffer,
): Promise<void> {
  const full = join(repo, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function initRepo(path: string, defaultBranch = "main"): Promise<void> {
  if (RECREATE) await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", defaultBranch, "-q"]);
  await git(path, ["config", "user.name", "Seed Bot"]);
  await git(path, ["config", "user.email", "seed@example.com"]);
  await git(path, ["config", "commit.gpgsign", "false"]);
  await git(path, ["config", "tag.gpgsign", "false"]);
}

async function commit(
  repo: string,
  files: Record<string, string | Buffer>,
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
  // A surviving remote would reject the recreated repo's fresh history
  // as a non-fast-forward push.
  if (RECREATE) {
    await rm(join(REMOTES, `${name}.git`), { recursive: true, force: true });
  }
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

// Distinct labelled square so seeded projects render a recognisable icon
// in the sidebar. Each seeder picks its own colour and label so it's
// obvious at a glance which icon-detection branch produced the rendered
// icon. Used by the icon-detection seed cases below.
function iconSvg(fill: string, label: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="6" fill="${fill}"/>` +
    `<text x="16" y="22" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="white" text-anchor="middle">${label}</text>` +
    `</svg>\n`
  );
}

// 1x1 solid-red PNG. Used to exercise the resolver's PNG mime path with
// bytes that actually decode in an <img>; the SVG cases test the more
// common formats.
const RED_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAFklEQVQI12P8/5+hngEFMDFAAcaCAFqcA0Aq8t5GAAAAAElFTkSuQmCC",
  "base64",
);

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
      // Icon detection: matches the src/favicon.svg candidate.
      "src/favicon.svg": iconSvg("#f59e0b", "bn"),
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
      "Icon detection: amber 'bn' tile (src/favicon.svg candidate).",
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
      // Icon detection: matches the public/favicon.svg candidate.
      "public/favicon.svg": iconSvg("#eab308", "pw"),
    },
    "Initial workspaces",
  );
  return {
    name: "pnpm-workspaces",
    path: repo,
    purpose: "pnpm workspaces — should detect packageManager: pnpm",
    tests: [
      "Package Scripts row says 'pnpm' and lists build + clean.",
      "Icon detection: yellow 'pw' tile (public/favicon.svg candidate).",
    ],
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
      // Icon detection: matches the root favicon.svg candidate (the top
      // of the resolver's priority list).
      "favicon.svg": iconSvg("#2dd4bf", "yc"),
    },
    "Initial",
  );
  return {
    name: "yarn-classic",
    path: repo,
    purpose: "yarn.lock present — should detect packageManager: yarn",
    tests: [
      "Package Scripts row says 'yarn'.",
      "Icon detection: teal 'yc' tile (root favicon.svg, top of the candidate list).",
    ],
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
      // Icon detection: exercises the PNG mime path with bytes that
      // actually decode in an <img> tag (1x1 red).
      "favicon.png": RED_PNG_1X1,
    },
    "Initial",
  );
  return {
    name: "npm-vanilla",
    path: repo,
    purpose: "No lockfile — falls back to packageManager: npm",
    tests: [
      "Package Scripts row says 'npm'.",
      "Icon detection: solid red 1x1 PNG dot (exercises the .png mime path with bytes that actually decode).",
    ],
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
    {
      "README.md": "# with-origin\n",
      "main.txt": "alpha\n",
      // Icon detection: matches the assets/logo.svg candidate.
      "assets/logo.svg": iconSvg("#22c55e", "wo"),
    },
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
      "Icon detection: green 'wo' tile (assets/logo.svg candidate).",
    ],
  };
}

async function seedNoRemote(): Promise<Manifest> {
  const repo = join(REPOS, "no-remote");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# no-remote\n",
      "notes.txt": "local only\n",
      // Icon detection: Docusaurus / SvelteKit / Hugo "static/" bucket.
      "static/favicon.svg": iconSvg("#0d9488", "nr"),
    },
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
      "Icon detection: teal 'nr' tile (static/favicon.svg — Docusaurus / SvelteKit / Hugo).",
    ],
  };
}

async function seedMultiRemote(): Promise<Manifest> {
  const remoteA = await bareRemote("multi-remote-a");
  const remoteB = await bareRemote("multi-remote-b");
  const repo = join(REPOS, "multi-remote");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# multi-remote\n",
      // Icon detection: VitePress convention.
      "docs/.vitepress/public/logo.svg": iconSvg("#7c3aed", "vp"),
    },
    "Initial",
  );
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
      "Icon detection: violet 'vp' tile (docs/.vitepress/public/logo.svg).",
    ],
  };
}

async function seedNonStandardDefault(): Promise<Manifest> {
  const repo = join(REPOS, "non-standard-default");
  await initRepo(repo, "trunk");
  await commit(
    repo,
    {
      "README.md": "# trunk-default\n\nOnly branch is `trunk`.\n",
      // Icon detection: matches the assets/icon.svg candidate.
      "assets/icon.svg": iconSvg("#a855f7", "tr"),
    },
    "Initial",
  );
  return {
    name: "non-standard-default",
    path: repo,
    purpose: "Only a `trunk` branch (no main/master/dev)",
    tests: [
      "Adding the project should detect `trunk` as the default branch (first local fallback).",
      "Configure → Default branch should show `trunk` selectable.",
      "Icon detection: purple 'tr' tile (assets/icon.svg candidate).",
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
    {
      "README.md": "# ahead-only\n",
      "log.txt": "line 1\n",
      // Icon detection: matches the Next.js src/app/icon.svg candidate.
      "src/app/icon.svg": iconSvg("#06b6d4", "ao"),
    },
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
      "Icon detection: cyan 'ao' tile (Next.js src/app/icon.svg candidate).",
    ],
  };
}

async function seedBehindOnly(): Promise<Manifest> {
  const remote = await bareRemote("behind-only");
  const repo = join(REPOS, "behind-only");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# behind-only\n",
      "log.txt": "line 1\n",
      // Icon detection: Mintlify convention. logo/light.svg is preferred
      // when both light + dark exist (current resolver isn't theme-aware).
      "logo/light.svg": iconSvg("#db2777", "mn"),
      "logo/dark.svg": iconSvg("#1e293b", "no"),
    },
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
      "Icon detection: pink 'mn' tile (logo/light.svg — Mintlify). Dark variant exists too at logo/dark.svg with a 'no' label; if you ever see that one in the sidebar the resolver picked the wrong variant.",
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

// Exercises the "Sync from primary" pill. Three feature-branch worktrees
// hang off `main`: one that rebases cleanly, one whose per-commit replay
// conflicts but whose final tree is mergeable (drives the merge
// fallback), and one already at the primary tip (control case -- pill
// must stay hidden). The primary itself is in sync with origin so its
// row stays quiet.
async function seedBehindPrimary(): Promise<Manifest> {
  const remote = await bareRemote("behind-primary");
  const repo = join(REPOS, "behind-primary");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# behind-primary\n",
      "foo.txt": "foo v1\n",
      "bar.txt": "bar line1\nbar line2\nbar line3\n",
      "shared.txt": "shared base\n",
    },
    "Base commit",
  );
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  // Branches off the base. We add the worktrees first (so the dirty
  // worktree-clone step happens before main moves), then advance main.
  await git(repo, ["branch", "feat/clean-sync", baseSha]);
  await git(repo, ["branch", "feat/merge-fallback", baseSha]);
  await git(repo, ["branch", "feat/up-to-date", baseSha]);

  await mkdir(EXTERNAL, { recursive: true });

  // 1. Clean rebase: own commit touches a file main never edits, so
  //    replaying it on top of the upstream commits lands without
  //    conflict.
  const cleanWt = join(EXTERNAL, "behind-primary-clean");
  await git(repo, ["worktree", "add", cleanWt, "feat/clean-sync"]);
  await commit(
    cleanWt,
    { "feat-only.txt": "feature-only work\n" },
    "Feature commit on its own file",
  );

  // 2. Merge fallback: commit B sets shared.txt to a local value; commit
  //    C lands on the same content main will later set. Per-commit
  //    rebase of B onto main's tip conflicts (expected "shared base"
  //    not present), but a whole-tree merge succeeds because HEAD and
  //    main agree on shared.txt's final content.
  const mergeWt = join(EXTERNAL, "behind-primary-merge-fallback");
  await git(repo, ["worktree", "add", mergeWt, "feat/merge-fallback"]);
  await commit(
    mergeWt,
    { "shared.txt": "shared local-B\n" },
    "Feature B sets shared to local-B",
  );
  await commit(
    mergeWt,
    { "shared.txt": "shared REMOTE\n" },
    "Feature C lands on REMOTE",
  );

  // 3. Up to date: branch stays at the base for now; once main moves
  //    we fast-forward it so behindPrimary stays 0.
  const upWt = join(EXTERNAL, "behind-primary-up-to-date");
  await git(repo, ["worktree", "add", upWt, "feat/up-to-date"]);

  // Advance main: three non-overlapping commits + the shared.txt rewrite
  // that powers the merge-fallback scenario. Pushed last so origin/main
  // matches the new local tip.
  await commit(
    repo,
    { "bar.txt": "bar line1\nbar UPSTREAM\nbar line3\n" },
    "Upstream rewrites bar line 2",
  );
  await commit(repo, { "foo.txt": "foo v2\n" }, "Upstream bumps foo");
  await commit(
    repo,
    { "shared.txt": "shared REMOTE\n" },
    "Upstream sets shared to REMOTE",
  );
  await git(repo, ["push", "origin", "main", "-q"]);

  // Fast-forward feat/up-to-date to main's tip. Done in the primary
  // checkout (it doesn't own the branch ref). Use `update-ref` so we
  // don't need a separate worktree just to move a branch pointer.
  const newTip = (await git(repo, ["rev-parse", "main"])).trim();
  await git(repo, ["update-ref", "refs/heads/feat/up-to-date", newTip]);

  // Refresh remote-tracking ref so HEAD..origin/main reflects the
  // post-push tip in each worktree's view.
  await git(repo, ["fetch", "origin", "-q"]);
  return {
    name: "behind-primary",
    path: repo,
    purpose:
      "Three feature worktrees exercising the 'Sync from primary' pill: clean rebase, merge fallback, and the already-up-to-date control",
    tests: [
      "Sidebar lists primary `main` plus 3 externals on feat/clean-sync, feat/merge-fallback, feat/up-to-date.",
      "feat/clean-sync detail header shows a sky 'Sync 3 from main' pill. Click it: rebase replays the feature commit on top of main and the pill clears. `git log --oneline` stays linear.",
      "feat/merge-fallback shows 'Sync 3 from main'. Click it: rebase conflicts on commit B, aborts, then merges cleanly. `git log --oneline` shows a merge commit afterward.",
      "feat/up-to-date does NOT show the pill (behindPrimary === 0).",
      "Primary worktree does NOT show the pill regardless of its upstream state -- the handler also rejects with 'The primary worktree is already on the primary branch' if invoked directly.",
    ],
  };
}

async function seedManyBranches(): Promise<Manifest> {
  const repo = join(REPOS, "many-branches");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# many-branches\n",
      // Icon detection: tests the index.html link-tag parser. The resolver
      // walks ICON_SOURCE_FILES after the candidates fail, extracts the
      // href, and resolves it against public/ first.
      "index.html": `<!doctype html><html><head><link rel="icon" href="/brand/logo.svg"/></head><body></body></html>\n`,
      "public/brand/logo.svg": iconSvg("#ec4899", "mb"),
    },
    "Initial",
  );

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
      'Icon detection: pink \'mb\' tile parsed out of index.html\'s <link rel="icon" href="/brand/logo.svg">, resolved against public/.',
    ],
  };
}

// Exercises the two-stage delete in Manage Branches: safe delete
// (`git branch -d`) first, then the force prompt when git refuses.
async function seedBranchDeleteStates(): Promise<Manifest> {
  const repo = join(REPOS, "branch-delete-states");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# branch-delete-states\n\nBranches in every mergedness state the delete flow distinguishes.\n",
      "base.txt": "base\n",
    },
    "Base commit",
  );
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  // Unique commits reachable from nowhere else -- `-d` refuses and the
  // force prompt shows the not-fully-merged banner.
  await git(repo, ["checkout", "-q", "-b", "unmerged-commits"]);
  await commit(
    repo,
    { "unmerged.txt": "only on this branch\n" },
    "Work that never landed",
  );

  // Squash-merge false positive: the branch's changes DO land on main,
  // but as a rewritten squash commit, so the branch's own commits stay
  // unreachable and `-d` still refuses.
  await git(repo, ["checkout", "-q", "-b", "squash-merged", baseSha]);
  await commit(repo, { "feature.txt": "squashed feature\n" }, "Feature work A");
  await commit(
    repo,
    { "feature.txt": "squashed feature\npolish\n" },
    "Feature work B",
  );
  await git(repo, ["checkout", "-q", "main"]);
  await git(repo, ["merge", "-q", "--squash", "squash-merged"]);
  await git(repo, ["commit", "-q", "-m", "Squash-merge feature (#1)"]);

  // Fully merged: ancestors of main -- safe delete succeeds outright.
  await git(repo, ["branch", "merged-at-tip"]);
  await git(repo, ["branch", "merged-behind", baseSha]);

  return {
    name: "branch-delete-states",
    path: repo,
    purpose:
      "Branches covering every safe-vs-force delete state in Manage Branches",
    tests: [
      "Manage Branches: `main` row's delete button is disabled (checked out in the primary).",
      "Delete `merged-at-tip`, then `merged-behind`: each deletes on the first confirm with no force prompt.",
      "Delete `unmerged-commits`: safe delete refuses, the modal shows the not-fully-merged banner, and the button flips to Force delete. Cancel and reopen: back at the safe stage. Force delete removes it and the list refreshes.",
      "Delete `squash-merged`: trips the same force prompt even though feature.txt landed on main via the squash commit -- the banner's squash-merge caveat in action.",
    ],
  };
}

async function seedDirtyPrimary(): Promise<Manifest> {
  const repo = join(REPOS, "dirty-primary");
  await initRepo(repo);
  await commit(
    repo,
    {
      "tracked.txt": "v1\n",
      // Icon detection: matches the JetBrains .idea/icon.svg candidate.
      ".idea/icon.svg": iconSvg("#f97316", "dp"),
    },
    "Initial",
  );
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
      "Icon detection: orange 'dp' tile (.idea/icon.svg candidate).",
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

// Commits with a backdated author AND committer date. The shared `git`
// helper pins identity but always commits "now"; the tidy-up page reads
// committer dates (%ct) to age a worktree, so staleness can only be
// staged by overriding both here.
async function commitAt(
  repo: string,
  files: Record<string, string>,
  message: string,
  daysAgo: number,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([rel, content]) => writeAt(repo, rel, content)),
  );
  const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  await execFileP("git", ["add", "-A"], {
    cwd: repo,
    env: { ...process.env, ...GIT_ENV },
  });
  await execFileP("git", ["commit", "-m", message, "-q"], {
    cwd: repo,
    env: {
      ...process.env,
      ...GIT_ENV,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  });
}

// Bulk filler under a gitignored node_modules/, so a worktree has a
// believable on-disk footprint without touching its git state. Sizes are
// small enough to keep seeding fast but far enough apart to sort visibly.
async function fakeDependencies(
  worktree: string,
  megabytes: number,
): Promise<void> {
  const chunk = "x".repeat(1024 * 1024);
  await Promise.all(
    Array.from({ length: megabytes }, (_unused, index) =>
      writeAt(worktree, `node_modules/filler-${index}/index.js`, chunk),
    ),
  );
}

// Exercises every verdict the "Tidy the forest" page can reach, with
// spread-out ages and disk footprints so the list has something to sort.
async function seedStaleWorktrees(): Promise<Manifest> {
  const remote = await bareRemote("stale-worktrees");
  const repo = join(REPOS, "stale-worktrees");
  await initRepo(repo);
  await commitAt(
    repo,
    {
      "README.md":
        "# stale-worktrees\n\nA forest that has been left to grow wild.\n",
      ".gitignore": "node_modules/\n",
      "package.json": pkgJson("stale-worktrees", { dev: "echo dev" }),
      "public/icon.svg": iconSvg("#10b981", "sw"),
      "src/index.ts": "export const version = 1;\n",
    },
    "Initial",
    240,
  );
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);

  await mkdir(EXTERNAL, { recursive: true });
  const base = join(EXTERNAL, "stale-worktrees");
  await mkdir(base, { recursive: true });
  const add = async (name: string, branch: string): Promise<string> => {
    const path = join(base, name);
    await git(repo, ["worktree", "add", "-b", branch, path, "main"]);
    return path;
  };

  // 1. Merged the ordinary way, clean, ancient, and by far the fattest.
  //    The headline "safe to remove" row.
  const abandoned = await add("abandoned-mint", "feature/old-onboarding");
  await commitAt(
    abandoned,
    { "src/onboarding.ts": "export const step = 1;\n" },
    "Add onboarding",
    150,
  );
  await git(repo, [
    "merge",
    "--no-ff",
    "-q",
    "feature/old-onboarding",
    "-m",
    "Merge onboarding",
  ]);
  await fakeDependencies(abandoned, 9);

  // 2. Squash-merged: still has commits main never took, so only the
  //    merge-tree probe can tell this is already landed.
  const shipped = await add("shipped-cedar", "feature/search");
  await commitAt(
    shipped,
    { "src/search.ts": "export const q = '';\n" },
    "Search groundwork",
    96,
  );
  await commitAt(
    shipped,
    { "src/search.ts": "export const q = '';\nexport const go = () => q;\n" },
    "Wire up search",
    94,
  );
  await git(repo, ["merge", "--squash", "-q", "feature/search"]);
  await git(repo, ["commit", "-m", "Add search (squashed)", "-q"]);
  await fakeDependencies(shipped, 5);

  // 3. Genuine unmerged work that was never pushed: the row the page must
  //    refuse to preselect.
  const halfDone = await add("half-done-fern", "feature/billing");
  await commitAt(
    halfDone,
    { "src/billing.ts": "export const todo = true;\n" },
    "Start billing",
    12,
  );
  await fakeDependencies(halfDone, 3);

  // 4. Branch is merged, but the working tree is dirty -- dirty must win
  //    over merged so nothing uncommitted is ever ticked.
  const messy = await add("messy-otter", "chore/tidy-imports");
  await git(repo, [
    "merge",
    "--no-ff",
    "-q",
    "chore/tidy-imports",
    "-m",
    "Merge tidy-imports",
  ]);
  await writeAt(
    messy,
    "src/index.ts",
    "export const version = 2; // half-finished edit\n",
  );
  await writeAt(messy, "scratch.md", "notes that were never committed\n");
  await fakeDependencies(messy, 2);

  // 5. Unmerged but pushed, so its commits survive removal: "Active work"
  //    rather than the louder "Unpushed commits".
  const fresh = await add("fresh-heron", "feature/dashboard");
  await commitAt(
    fresh,
    { "src/dashboard.ts": "export const live = true;\n" },
    "Dashboard shell",
    2,
  );
  await git(fresh, ["push", "-u", "origin", "feature/dashboard", "-q"]);
  await fakeDependencies(fresh, 1);

  // Publish the landed merges. Without this, origin/main still points at
  // the initial commit and -- since resolveDefaultBranch prefers the
  // remote-tracking ref -- every merged branch would be compared against
  // an empty main. That is the realistic state anyway: you push what you
  // merge.
  await git(repo, ["push", "origin", "main", "-q"]);

  return {
    name: "stale-worktrees",
    path: repo,
    purpose:
      "Five worktrees covering every verdict on the 'Tidy the forest' page",
    tests: [
      "Settings -> 'Tidy up worktrees…' lists these 5 worktrees + the primary, alongside every other registered project.",
      "abandoned-mint is 'Merged' and shipped-cedar is 'Already in primary'; both are preselected.",
      "messy-otter ('Uncommitted work'), half-done-fern ('Unpushed commits') and fresh-heron ('Active work') are NOT preselected.",
      "Sizes fill in progressively and sort abandoned-mint (~9 MB) to the top under Size, above every other project's worktrees.",
      "Ticking messy-otter forces the confirm dialog's acknowledgement checkbox before Remove enables.",
    ],
  };
}

// A second forest, so the app-wide page has more than one project to
// span: cross-project sorting, the "Project" grouping, and the confirm
// dialog's "across N projects" line all need two repos to mean anything.
// Deliberately small -- its job is to be a second row source, not to
// re-cover the verdicts stale-worktrees already covers.
async function seedStaleSatellite(): Promise<Manifest> {
  const remote = await bareRemote("stale-satellite");
  const repo = join(REPOS, "stale-satellite");
  await initRepo(repo);
  await commitAt(
    repo,
    {
      "README.md": "# stale-satellite\n\nA smaller wood, next door.\n",
      ".gitignore": "node_modules/\n",
      "package.json": pkgJson("stale-satellite", { dev: "echo dev" }),
      "public/icon.svg": iconSvg("#0ea5e9", "ss"),
      "src/index.ts": "export const version = 1;\n",
    },
    "Initial",
    120,
  );
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main", "-q"]);

  await mkdir(EXTERNAL, { recursive: true });
  const base = join(EXTERNAL, "stale-satellite");
  await mkdir(base, { recursive: true });
  const add = async (name: string, branch: string): Promise<string> => {
    const path = join(base, name);
    await git(repo, ["worktree", "add", "-b", branch, path, "main"]);
    return path;
  };

  // Merged, clean, and older than anything in stale-worktrees: under
  // "Age" it should sort above that project's rows, which is the whole
  // point of one list across every project.
  const landed = await add("quiet-badger", "feature/legacy-import");
  await commitAt(
    landed,
    { "src/import.ts": "export const legacy = true;\n" },
    "Legacy import",
    200,
  );
  await git(repo, [
    "merge",
    "--no-ff",
    "-q",
    "feature/legacy-import",
    "-m",
    "Merge legacy import",
  ]);
  await fakeDependencies(landed, 4);

  // Unmerged and unpushed, so this project always has something the page
  // refuses to tick -- a group that can't be cleared in one go.
  const wip = await add("busy-lark", "feature/notifications");
  await commitAt(
    wip,
    { "src/notify.ts": "export const soon = true;\n" },
    "Notification shell",
    5,
  );
  await fakeDependencies(wip, 1);

  await git(repo, ["push", "origin", "main", "-q"]);

  return {
    name: "stale-satellite",
    path: repo,
    purpose:
      "Second project for the app-wide 'Tidy the forest' page: one merged worktree, one unpushed",
    tests: [
      "Register this alongside stale-worktrees: the tidy page lists both projects' worktrees in one list, each row prefixed with its project.",
      "Sorting by 'Project' groups the rows under per-project headings carrying each project's worktree count and size.",
      "quiet-badger (~200 days) sorts to the top under Age, above every stale-worktrees row.",
      "Selecting quiet-badger plus abandoned-mint makes the confirm dialog read 'across 2 projects'.",
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
      // Icon detection: tests the JSX object parser. The resolver walks
      // ICON_SOURCE_FILES, finds the { rel: "icon", href: "/icon.svg" }
      // object, then resolves the href against public/.
      "src/routes/__root.tsx":
        `import { createRootRoute, Outlet } from "@tanstack/react-router";\n\n` +
        `export const Route = createRootRoute({\n` +
        `  head: () => ({\n` +
        `    links: [{ rel: "icon", href: "/icon.svg" }],\n` +
        `  }),\n` +
        `  component: () => <Outlet />,\n` +
        `});\n`,
      "public/icon.svg": iconSvg("#6366f1", "ce"),
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
      'Icon detection: indigo \'ce\' tile parsed out of src/routes/__root.tsx\'s { rel: "icon", href: "/icon.svg" } object, resolved against public/.',
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
      // Icon detection: matches the Next.js app/icon.svg candidate.
      "app/icon.svg": iconSvg("#84cc16", "cr"),
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
      "Icon detection: lime 'cr' tile (Next.js app/icon.svg candidate).",
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

// Exercises .worktreeinclude support: gitignore-syntax patterns whose
// gitignored matches are copied (never symlinked) into new worktrees,
// plus the auto-removal of manual carry-over entries the file covers.
async function seedWorktreeInclude(): Promise<Manifest> {
  const repo = join(REPOS, "worktreeinclude");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md":
        "# worktreeinclude\n\nExercises .worktreeinclude resolution, reconciliation, and the per-project toggle.\n",
      ".gitignore": ".env\n.env.local\nnode_modules/\n*.log\n",
      // Committed, as a real repo would ship it. Contains, in order:
      // a comment + blank line (must be filtered from the Configure list),
      // two gitignored matches (.env, node_modules/), a negation pair
      // (*.log minus debug.log), a match on a TRACKED file (must not
      // copy), and a match on an untracked NON-ignored file (must not
      // copy either -- spec requires matched AND gitignored).
      ".worktreeinclude":
        "# Copied into every new worktree when gitignored\n" +
        "\n" +
        ".env\n" +
        "node_modules/\n" +
        "*.log\n" +
        "!debug.log\n" +
        "tracked.txt\n" +
        "notes.txt\n",
      "package.json": pkgJson("worktreeinclude", {
        hello: "echo 'hi from worktreeinclude'",
      }),
      "tracked.txt": "committed content\n",
      "src/index.ts": "export {};\n",
    },
    "Initial",
  );
  // Gitignored candidates.
  await writeAt(repo, ".env", "FAKE_API_KEY=wt-include\n");
  // Gitignored but matched by no pattern: control, must not copy.
  await writeAt(repo, ".env.local", "OVERRIDE=true\n");
  await writeAt(
    repo,
    "node_modules/placeholder/package.json",
    `${JSON.stringify({ name: "placeholder", version: "0.0.0" })}\n`,
  );
  await writeAt(repo, "app.log", "copied via *.log\n");
  await writeAt(repo, "debug.log", "negated via !debug.log, must not copy\n");
  // Untracked and NOT gitignored; matched by pattern, must not copy.
  await writeAt(repo, "notes.txt", "untracked scratch notes\n");
  return {
    name: "worktreeinclude",
    path: repo,
    purpose:
      ".worktreeinclude patterns (comments, dirs, negation, tracked/non-ignored traps) plus manual-entry reconciliation",
    tests: [
      "Configure → Carry over: the 'Use .worktreeinclude' toggle row is on by default, and .env, node_modules, app.log appear as read-only rows in the carry-over list with a static Copy indicator, a 'used by .worktreeinclude' note, and a disabled remove button.",
      "Carry-over picker: .env, node_modules/, app.log show a 'covered' label instead of Symlink/Copy buttons; .env.local still offers both. Toggle .worktreeinclude off and reopen: the buttons return.",
      "Create a worktree: .env, node_modules/, app.log are copied (real files, not symlinks); debug.log, tracked.txt, notes.txt, .env.local are NOT; .git/info/exclude gains no lines from include entries.",
      "Reconciliation: add .env as a manual entry (any mode) and save; the row shows the amber 'covered' badge. Create a worktree: the entry disappears from Configure, and a toast explains a .worktreeinclude update removed it.",
      "Symlink downgrade: add node_modules as a manual Symlink entry, save, create a worktree. The entry is auto-removed (toast) and the new worktree gets a copied node_modules, not a symlink.",
      "Draft race: dirty the form (edit the setup script, don't save), create a worktree, then Save. The removed entries must not reappear in ~/shigomori-dev/projects/<id>/project.json.",
      "Toggle .worktreeinclude off, save, create a worktree: the read-only rows disappear, nothing from the file is copied, manual entries untouched, no reconcile toast.",
      "File-missing state: in a repo without the file (e.g. carryover-rich) the toggle row is hidden entirely while the toggle is on, and reappears (for re-enabling) after toggling it off.",
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
      // Icon detection: confirms the resolver and IPC handle a project
      // path that contains a space.
      "public/favicon.svg": iconSvg("#14b8a6", "sp"),
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
      "Icon detection: teal 'sp' tile (public/favicon.svg with a space in the cwd).",
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
      // Icon detection: confirms the unicode project path round-trips
      // through the resolver and IPC base64 encoding.
      "favicon.svg": iconSvg("#f43f5e", "プ"),
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
      "Icon detection: rose 'プ' tile (root favicon.svg under a unicode cwd).",
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
      // Icon detection: Tauri convention.
      "src-tauri/icons/icon.svg": iconSvg("#65a30d", "tr"),
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
      "Icon detection: lime 'tr' tile (src-tauri/icons/icon.svg — Tauri).",
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
      // Icon detection: Astro convention (src/assets/).
      "src/assets/logo.svg": iconSvg("#d97706", "as"),
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
      "Icon detection: amber 'as' tile (src/assets/logo.svg — Astro).",
    ],
  };
}

async function seedManyScripts(): Promise<Manifest> {
  const repo = join(REPOS, "many-scripts");
  await initRepo(repo);
  // 30 scripts spanning the alphabet and the typical buckets you'd want to
  // sort by (dev/build/test/lint/format/release/db/deploy/etc.). Each one
  // is cheap to run so it's easy to click through and seed the use log
  // when exercising the "Most recently used" and "Most used" sort modes.
  const scripts: Record<string, string> = {
    "analyze:bundle": "echo 'analyzing bundle...'",
    build: "echo 'build complete'",
    "build:prod": "echo 'production build complete'",
    "build:staging": "echo 'staging build complete'",
    "check:deps": "echo 'checking deps for updates'",
    clean: "echo 'cleaning build artifacts'",
    "clean:cache": "echo 'cleaning cache'",
    "db:migrate": "echo 'running migrations'",
    "db:reset": "echo 'reset database'",
    "db:seed": "echo 'seeding database'",
    "deploy:prod": "echo 'deploy to prod'",
    "deploy:staging": "echo 'deploy to staging'",
    dev: "echo 'starting dev server...' && sleep 3600",
    "docs:build": "echo 'docs built'",
    "docs:serve": "echo 'serving docs' && sleep 3600",
    format: "echo 'formatting'",
    "format:check": "echo 'format check'",
    lint: "echo 'linting'",
    "lint:fix": "echo 'lint --fix'",
    preview: "echo 'preview server' && sleep 3600",
    release: "echo 'releasing'",
    "release:dry": "echo 'release dry run'",
    start: "echo 'started'",
    storybook: "echo 'storybook running' && sleep 3600",
    test: "echo '5 passed'",
    "test:e2e": "echo 'e2e passed'",
    "test:unit": "echo 'unit passed'",
    "test:watch": "echo 'watching tests' && sleep 3600",
    typecheck: "echo 'tsc clean'",
    validate: "echo 'validate'",
  };
  await commit(
    repo,
    {
      "README.md":
        "# many-scripts\n\n30 scripts for exercising the per-repo sort modes (default / alphabetical / most recently used / most used).\n",
      ".gitignore": "node_modules/\n",
      "package.json": pkgJson("many-scripts", scripts),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    },
    "Initial",
  );
  return {
    name: "many-scripts",
    path: repo,
    purpose:
      "Repo with 30 package.json scripts for exercising sort modes and search",
    tests: [
      "First visit: section starts on 'Most used' (the implicit default for a fresh repo) — with no run history yet, entries fall back to alphabetical.",
      "Switch to 'package.json' — entries appear in the manifest's declared order (alphabetized in this fixture, but exercising the manifest-order branch).",
      "Switch to Alphabetical — order is identical here, confirming the sort runs without flicker.",
      "Run a handful of scripts (e.g. `validate`, `lint`, `test`, `db:seed`). Navigate away and back; switch to 'Most recently used' — those four float to the top in run order (latest first), tiebroken alphabetically.",
      "Run `lint` several more times. Re-mount the page, then 'Most used' shows `lint` on top; ties below it sort alphabetically.",
      "Order does NOT shift mid-session when a script is bumped — only on re-mount (matches launcher behavior).",
      "The sort preference is persisted: pick a non-default mode, restart, and the same mode is selected.",
      "Open a different project with package scripts — its sort starts on 'Most used'; sort is per-repo.",
      "Search overrides the sort while the query box is non-empty (relevance order); clearing the query restores the chosen sort.",
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
  lines.push("## Icon detection coverage");
  lines.push("");
  lines.push(
    "Each repo below seeds a uniquely-coloured icon so the resolver's branches " +
      "can be eyeballed in the sidebar. Repos not listed here intentionally have " +
      "no detectable icon (the 'render nothing' control).",
  );
  lines.push("");
  lines.push("| Repo | Path | Branch tested |");
  lines.push("| --- | --- | --- |");
  lines.push(
    "| yarn-classic | `favicon.svg` | root SVG (top of candidate list) |",
  );
  lines.push("| npm-vanilla | `favicon.png` | root PNG mime path |");
  lines.push(
    "| pnpm-workspaces | `public/favicon.svg` | `public/` candidate |",
  );
  lines.push("| path with spaces | `public/favicon.svg` | space in cwd |");
  lines.push("| bun-basic | `src/favicon.svg` | `src/` candidate |");
  lines.push(
    "| ahead-only | `src/app/icon.svg` | Next.js `src/app/` candidate |",
  );
  lines.push(
    "| carryover-rich | `app/icon.svg` | Next.js root `app/` candidate |",
  );
  lines.push(
    "| with-origin | `assets/logo.svg` | `assets/logo.svg` candidate |",
  );
  lines.push(
    "| non-standard-default | `assets/icon.svg` | `assets/icon.svg` candidate |",
  );
  lines.push(
    "| dirty-primary | `.idea/icon.svg` | JetBrains `.idea/` candidate |",
  );
  lines.push(
    '| many-branches | `index.html` → `public/brand/logo.svg` | HTML `<link rel="icon">` parser |',
  );
  lines.push(
    '| convertible-externals | `src/routes/__root.tsx` → `public/icon.svg` | JSX `{ rel: "icon", href: ... }` parser |',
  );
  lines.push("| プロジェクト | `favicon.svg` | unicode cwd |");
  lines.push(
    "| no-remote | `static/favicon.svg` | Docusaurus / SvelteKit / Hugo `static/` bucket |",
  );
  lines.push(
    "| multi-remote | `docs/.vitepress/public/logo.svg` | VitePress |",
  );
  lines.push(
    "| behind-only | `logo/light.svg` (+ unused `logo/dark.svg`) | Mintlify (light variant wins, no theme awareness yet) |",
  );
  lines.push("| port-pool-basic | `src-tauri/icons/icon.svg` | Tauri |");
  lines.push("| port-pool-monorepo | `src/assets/logo.svg` | Astro |");
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
    "Usage: pnpm seed <dest-dir> [--keep] [--only=<name>[,<name>...]]\n" +
      "\n" +
      "  <dest-dir>      Absolute or relative path where the seed tree will live.\n" +
      "                  Required so worktree `.git` pointers stay self-contained.\n" +
      "  --keep          Skip wiping <dest-dir> before seeding.\n" +
      "  --only=<names>  Run just the named seeder(s), recreating their repos\n" +
      "                  and remotes in place. Implies --keep and leaves\n" +
      "                  README.md untouched. Seeders that create external\n" +
      "                  worktrees still need external/ cleaned up by hand.",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv
    .filter((a) => a.startsWith("--only="))
    .flatMap((a) => a.slice("--only=".length).split(","))
    .filter((n) => n.length > 0);
  // --only adds to an existing tree, so it implies --keep.
  const keep = argv.includes("--keep") || only.length > 0;
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
  if (only.length > 0) {
    RECREATE = true;
    // Sidecar clones are build-time scratch (git clone needs an empty
    // destination), so they are safe to clear wholesale.
    await rm(SIDECAR, { recursive: true, force: true });
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
    { name: "behind-primary", run: seedBehindPrimary },
    { name: "many-branches", run: seedManyBranches },
    { name: "branch-delete-states", run: seedBranchDeleteStates },
    { name: "dirty-primary", run: seedDirtyPrimary },
    { name: "pre-existing-worktrees", run: seedPreExistingWorktrees },
    { name: "stale-worktrees", run: seedStaleWorktrees },
    { name: "stale-satellite", run: seedStaleSatellite },
    { name: "convertible-externals", run: seedConvertibleExternals },
    { name: "carryover-rich", run: seedCarryoverRich },
    { name: "carryover-symlink-dir", run: seedCarryoverSymlinkDir },
    { name: "worktreeinclude", run: seedWorktreeInclude },
    { name: "path with spaces", run: seedPathSpaces },
    { name: "プロジェクト", run: seedUnicodePath },
    { name: "deeply-nested", run: seedDeeplyNested },
    { name: "port-pool-basic", run: seedPortPoolBasic },
    { name: "port-pool-monorepo", run: seedPortPoolMonorepo },
    { name: "port-pool-invalid-config", run: seedPortPoolInvalid },
    { name: "many-scripts", run: seedManyScripts },
  ];

  if (only.length > 0) {
    const known = new Set(seeders.map((s) => s.name));
    const unknown = only.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      console.error(
        `✖ Unknown seeder(s): ${unknown.join(", ")}\n` +
          `  Available: ${seeders.map((s) => s.name).join(", ")}`,
      );
      process.exit(2);
    }
  }
  const selected =
    only.length > 0 ? seeders.filter((s) => only.includes(s.name)) : seeders;

  const results = await Promise.allSettled(selected.map((s) => s.run()));
  const manifests: Manifest[] = [];
  const failures: Array<{ name: string; error: Error }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const s = selected[i];
    if (r.status === "fulfilled") manifests.push(r.value);
    else
      failures.push({
        name: s.name,
        error:
          r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
      });
  }

  // A partial run would clobber the full README with just its own repos.
  if (only.length === 0 && manifests.length > 0) await writeReadme(manifests);
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
