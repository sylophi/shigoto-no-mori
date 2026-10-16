// The repositories the fixture patches come from (src/fixtures/patches.ts).
// Each is built by git in a temp folder and read with the host's own
// git arguments, so a patch the fake host, the scenes or the marketing
// site draws is one git printed, never one written by hand: its hunk
// counts, its blob ids and its headers are git's. fixturePatches.test.ts
// rebuilds them and fails when the module no longer matches.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Git = (...args: string[]) => string;

// git under the suite's isolation (vitest.config.ts) with no global or
// system config, and a pinned identity and locale.
function gitIn(repo: string): Git {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "sm",
    GIT_AUTHOR_EMAIL: "sm@example.test",
    GIT_COMMITTER_NAME: "sm",
    GIT_COMMITTER_EMAIL: "sm@example.test",
    LC_ALL: "C",
  };
  // A diff exits 1 when it finds changes, which --no-index always does.
  return (...args) => {
    try {
      return execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
    } catch (error) {
      const { status, stdout } = error as { status: number; stdout: string };
      if (status === 1 && args.includes("--no-index")) return stdout;
      throw error;
    }
  };
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
}

function withRepo<T>(build: (repo: string, git: Git) => T): T {
  const repo = mkdtempSync(join(tmpdir(), "sm-ui-fixture-"));
  try {
    const git = gitIn(repo);
    git("init", "-q", "-b", "main");
    return build(repo, git);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// What every host patch carries (packages/engine/src/git/documents.ts).
const PATCH_CONFIG = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
];
const PATCH_FLAGS = ["--no-ext-diff", "--no-textconv"];

// The host's commit patch (packages/engine/src/Git.ts, commitDiff).
const commitDiff = (git: Git, hash: string) =>
  git(
    "-c",
    "core.quotePath=false",
    ...PATCH_CONFIG,
    "show",
    "--format=",
    "--no-color",
    "--full-index",
    ...PATCH_FLAGS,
    "--diff-merges=first-parent",
    "--end-of-options",
    hash,
    "--",
  );

// The two sides of the commit's icon, drawn as SVG, which is all a
// diff's preview sees. .gitattributes calls a .png binary, so git
// prints the patch an image gets.
const ICON_SIDES = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><circle cx="64" cy="64" r="56" fill="#9ca3af"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect x="8" y="8" width="112" height="112" rx="28" fill="#16a34a"/><path d="M40 84c0-28 20-44 48-44 0 28-16 48-44 48" fill="#bbf7d0"/></svg>`,
] as const;

const ROW_CONTENT = (
  badge: boolean,
) => `import type { SidebarRow } from "./sidebarRows";
import { RowTag } from "@/components/ui/row-tag";
import { WorktreeRowLabel } from "./WorktreeRow";
${badge ? 'import { DeviceBadge } from "./DeviceBadge";\n' : ""}
export function RowContent({ row }: { row: SidebarRow }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <WorktreeRowLabel row={row} />
      {row.tag && <RowTag>{row.tag}</RowTag>}
${badge ? "      {row.device && <DeviceBadge label={row.device} />}\n" : ""}    </div>
  );
}
`;

const WORKTREE_ROW = (transition: boolean) => `import { cn } from "@/lib/utils";
import { useWorktreeRowState } from "./useWorktreeRowState";

export const WORKTREE_ROW_BUTTON =
  "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs${transition ? " transition-colors" : ""}";

export function WorktreeRowLabel({ row }: { row: { name: string } }) {
  const { active } = useWorktreeRowState(row.name);
  return <span className={cn("truncate", active && "font-medium")}>{row.name}</span>;
}
`;

const DEVICE_BADGE = `import { RowTag } from "@/components/ui/row-tag";

// The owning device, as a two-letter tag at the row's trailing edge.
export function DeviceBadge({ label }: { label: string }) {
  const short = label.slice(0, 2).toUpperCase();
  return <RowTag title={label}>{short}</RowTag>;
}
`;

// FAKE_DIFF: a commit that changes an image, adds a file and changes
// two, so the diff pages pose a file index and the phone's sheet.
export function buildCommitPatch() {
  return withRepo((repo, git) => {
    write(repo, {
      ".gitattributes": "*.png binary\n",
      "public/icon.png": ICON_SIDES[0],
      "renderer/components/sidebar/RowContent.tsx": ROW_CONTENT(false),
      "renderer/components/sidebar/WorktreeRow.tsx": WORKTREE_ROW(false),
    });
    git("add", ".");
    git("commit", "-q", "-m", "base");
    write(repo, {
      "public/icon.png": ICON_SIDES[1],
      "renderer/components/sidebar/RowContent.tsx": ROW_CONTENT(true),
      "renderer/components/sidebar/WorktreeRow.tsx": WORKTREE_ROW(true),
      "renderer/components/sidebar/DeviceBadge.tsx": DEVICE_BADGE,
    });
    git("add", ".");
    git("commit", "-q", "-m", "Badge merged projects with their device");
    const oid = (rev: string) => git("rev-parse", rev).trim();
    return {
      patch: commitDiff(git, "HEAD"),
      icon: ICON_SIDES.map((svg, i) => ({
        oid: oid(`HEAD${i === 0 ? "~1" : ""}:public/icon.png`),
        svg,
      })),
    };
  });
}

const CODE = [
  'import { cn } from "@/lib/utils";',
  'import { pluralize } from "@/lib/pluralize";',
  'import type { ChangedFile } from "@shigomori/contracts/schemas";',
  "",
  "// What the button says it will do.",
  "export function label(count: number, amending: boolean): string {",
  '  const what = pluralize(count, "file");',
  "  return amending ? `Amend with ${what}` : `Commit ${what}`;",
  "}",
  "",
  "export function tone(ahead: number): string {",
  '  return ahead > 0 ? "text-emerald-500" : "text-muted-foreground";',
  "}",
  "",
  "export function included(files: readonly ChangedFile[]): number {",
  '  return files.filter((file) => file.staged !== "none").length;',
  "}",
  "",
  "export const SUMMARY_SOFT_LIMIT = 72;",
  "",
  "export function overLimit(summary: string): boolean {",
  "  return summary.trim().length > SUMMARY_SOFT_LIMIT;",
  "}",
  "",
  'export const scope = (all: boolean) => (all ? "all" : "some");',
];

// `count` lines of CODE from `offset`, wrapping, as a file's text.
const text = (count: number, offset = 0) =>
  Array.from(
    { length: count },
    (_, i) => `${CODE[(i + offset) % CODE.length]}\n`,
  ).join("");

// The changes page's working tree (changesFixtures.ts's POOL): each
// kind of change git status reports, the rename and the staged add as
// `git mv` and `git add` leave them.
const BASE = {
  "README.md": "# lab\n\nThe lab's app.\n\n## Running\n\npnpm dev\n",
  "renderer/components/diff/CommitComposer.tsx": text(60),
  "renderer/lib/toast.tsx": text(20, 5),
  "renderer/lib/villagerVoice.ts": text(30, 9),
  "renderer/components/worktreeDetail/commits/useSyncState.ts": text(12, 2),
  "shared/legacy/oldStatus.ts": text(21, 3),
};

export function buildChangesPatches() {
  return withRepo((repo, git) => {
    write(repo, BASE);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git(
      "mv",
      "renderer/components/worktreeDetail/commits/useSyncState.ts",
      "renderer/components/worktreeDetail/commits/useWorktreeSyncAvailability.ts",
    );
    write(repo, {
      "README.md": `${BASE["README.md"]}\n## Testing\n\npnpm test\n`,
      "renderer/components/diff/CommitComposer.tsx":
        text(10) + text(12, 13) + text(26, 11) + text(26, 36),
      "renderer/lib/toast.tsx": text(9, 5) + text(4, 17) + text(10, 15),
      "renderer/lib/villagerVoice.ts": text(5, 9) + text(12, 1) + text(22, 17),
      "renderer/components/worktreeDetail/commits/useWorktreeSyncAvailability.ts":
        text(4, 2) + text(2, 11) + text(6, 8),
      "renderer/components/sidebar/DeviceBadge.tsx": DEVICE_BADGE,
      "app/test/proofs/commitComposer.test.ts": text(64, 6),
    });
    git("rm", "-q", "shared/legacy/oldStatus.ts");
    git("add", "renderer/components/sidebar/DeviceBadge.tsx");

    // What the host's fileDiff prints for one picked file
    // (packages/engine/src/git/diffs.ts): against HEAD, or an untracked
    // file against /dev/null. A rename names both paths.
    const fileDiff = (
      paths: string[],
      untracked: boolean,
      ...extra: string[]
    ) =>
      git(
        "-c",
        "core.quotePath=false",
        ...PATCH_CONFIG,
        ...(untracked
          ? [
              "diff",
              "--no-index",
              "--no-color",
              "--full-index",
              ...PATCH_FLAGS,
              ...extra,
              "--",
              "/dev/null",
              ...paths,
            ]
          : [
              "diff",
              "HEAD",
              "--no-color",
              "--full-index",
              ...PATCH_FLAGS,
              ...extra,
              "--",
              ...paths,
            ]),
      );
    // What the changes list counts, git's numstat for the same diff.
    const countsOf = (paths: string[], untracked: boolean) => {
      const [additions = 0, deletions = 0] = fileDiff(
        paths,
        untracked,
        "--numstat",
      )
        .split("\t")
        .map(Number);
      return { additions, deletions };
    };
    // The changes the hunk ticks read (packages/engine/src/git/hunks.ts).
    const hunks = (path: string) =>
      [
        ...git(
          "diff",
          "--no-color",
          "--no-renames",
          "-U0",
          "HEAD",
          "--",
          path,
        ).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
      ].map(([, oldStart, oldCount, newStart, newCount]) => ({
        oldStart: Number(oldStart),
        oldCount: Number(oldCount ?? 1),
        newStart: Number(newStart),
        newCount: Number(newCount ?? 1),
      }));

    const files: Array<{ path: string; prevPath?: string; untracked?: true }> =
      [
        { path: "README.md" },
        { path: "app/test/proofs/commitComposer.test.ts", untracked: true },
        { path: "renderer/components/diff/CommitComposer.tsx" },
        { path: "renderer/components/sidebar/DeviceBadge.tsx" },
        {
          path: "renderer/components/worktreeDetail/commits/useWorktreeSyncAvailability.ts",
          prevPath:
            "renderer/components/worktreeDetail/commits/useSyncState.ts",
        },
        { path: "renderer/lib/toast.tsx" },
        { path: "renderer/lib/villagerVoice.ts" },
        { path: "shared/legacy/oldStatus.ts" },
      ];
    return Object.fromEntries(
      files.map(({ path, prevPath, untracked = false }) => {
        const paths = prevPath ? [prevPath, path] : [path];
        return [
          path,
          {
            patch: fileDiff(paths, untracked),
            counts: countsOf(paths, untracked),
            hunks: untracked ? [] : hunks(path),
          },
        ];
      }),
    );
  });
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

// The module the fixtures import, as the test writes it. A patch is
// written as its lines, so a change to a fixture reads as one in review.
export function renderPatchesModule(): string {
  const commit = buildCommitPatch();
  const changes = buildChangesPatches();
  const patch = (printed: string) => `patch(${json(printed.split("\n"))})`;
  const entries = Object.entries(changes).map(
    ([path, change]) =>
      `${json(path)}: { patch: ${patch(change.patch)}, counts: ${json(change.counts)}, hunks: ${json(change.hunks)} },`,
  );
  return `// Generated by packages/ui/test/fixturePatches.test.ts from the
// repositories in test/lib/fixtureRepos.ts: every patch here is what git
// printed for them with the host's own arguments. Don't edit it: change
// the repositories and run \`UPDATE_FIXTURES=1 pnpm -F @shigomori/ui test fixturePatches\`.

const patch = (lines: readonly string[]) => lines.join("\\n");

// A commit changing an image, adding a file and changing two.
export const COMMIT_PATCH = ${patch(commit.patch)};

// The image's two sides, by the blob ids the patch names.
export const COMMIT_ICON_SIDES = ${json(commit.icon)};

// The changes page's files: each one's patch as the changes page reads
// it, its counts and the hunks its ticks pick from.
export const CHANGE_PATCHES: Record<
  string,
  {
    patch: string;
    counts: { additions: number; deletions: number };
    hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }>;
  }
> = {
${entries.join("\n")}
};
`;
}
