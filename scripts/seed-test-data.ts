// Seeds /tmp/shigomori-seed/ with a tree of throwaway git repos that
// exercise every state surface in Shigoto no Mori's UI:
//   - package-manager detection (bun / pnpm / yarn / npm / none)
//   - ahead / behind / dirty / detached / unknown-branch worktrees
//   - remotes (one, none, multiple) and default-branch resolution
//   - external (non-managed) worktrees and occupied branches
//   - gitignored carry-over candidates
//   - path shapes (spaces, unicode, deeply nested)
//
// Run:   bun scripts/seed-test-data.ts [--keep]
// Wipes /tmp/shigomori-seed/ by default. --keep skips the wipe.
//
// The script does NOT touch ~/shigomori-dev/. Add each repo via the app.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ROOT = "/tmp/shigomori-seed";
const REPOS = join(ROOT, "repos");
const REMOTES = join(ROOT, "remotes");
const EXTERNAL = join(ROOT, "external");
const SIDECAR = join(ROOT, ".sidecar");

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

async function bareRemote(name: string, defaultBranch = "main"): Promise<string> {
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
    purpose: "Bun project with rich scripts and gitignored carry-over candidates",
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
      "packages/foo/package.json":
        `${JSON.stringify({ name: "@ws/foo", version: "0.0.0" }, null, 2)}\n`,
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
      "README.md": "# no-package-json\n\nPlain repo with no Node.js metadata.\n",
      "src/main.go": "package main\n\nfunc main() {}\n",
    },
    "Initial",
  );
  return {
    name: "no-package-json",
    path: repo,
    purpose: "Repo without package.json",
    tests: ["Package Scripts section should hide or show its empty state cleanly."],
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
  await commit(repo, { "local.txt": "local change\n" }, "Local commit");
  await git(repo, ["fetch", "origin", "-q"]);
  return {
    name: "ahead-behind-divergent",
    path: repo,
    purpose: "Local main diverged from origin/main — 1 ahead AND 1 behind",
    tests: [
      "Sidebar shows both ahead (↑1) and behind (↓1) indicators.",
      "Last-commit metadata should still render (local HEAD).",
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

async function seedPathSpaces(): Promise<Manifest> {
  const repo = join(REPOS, "path with spaces");
  await initRepo(repo);
  await commit(
    repo,
    {
      "README.md": "# spaces in path\n",
      "package.json": pkgJson("path-with-spaces", { hello: "echo 'spaces ok'" }),
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

// ─── Orchestration ────────────────────────────────────────────────────────

async function writeReadme(manifests: Manifest[]): Promise<void> {
  const lines: string[] = [
    "# Shigoto no Mori — manual test seed",
    "",
    "Throwaway repos under `/tmp/shigomori-seed/repos/`, each exercising a",
    "different slice of the app. Add each one in the app and follow the",
    "checklist below.",
    "",
    "Regenerate any time with:",
    "",
    "    bun scripts/seed-test-data.ts",
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
  lines.push("- `external/` — git worktrees pre-created outside the managed dir.");
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
    green(`✓ Seeded ${manifests.length} repos in ${(elapsedMs / 1000).toFixed(1)}s`),
  );
  console.log("");
  for (const m of manifests) {
    console.log(`  ${m.path}`);
    console.log(`    ${dim(m.purpose)}`);
  }
  console.log("");
  console.log(
    `Manifest with test checklists: ${dim(join(ROOT, "README.md"))}`,
  );
  console.log(
    `Next: launch the app and Add Project for each path above.`,
  );
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
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
    { name: "many-branches", run: seedManyBranches },
    { name: "dirty-primary", run: seedDirtyPrimary },
    { name: "pre-existing-worktrees", run: seedPreExistingWorktrees },
    { name: "carryover-rich", run: seedCarryoverRich },
    { name: "path with spaces", run: seedPathSpaces },
    { name: "プロジェクト", run: seedUnicodePath },
    { name: "deeply-nested", run: seedDeeplyNested },
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
        error: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
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
