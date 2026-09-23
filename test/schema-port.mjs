// Durable proof for the zod-to-Schema port (EFFECT-MIGRATION.md,
// Phase 4): every schema moved to Effect Schema decodes and refuses
// exactly what its zod version did. Pure: no sockets, no Electron.
//
// The expectations below are the zod versions' results, recorded by
// running them before the port. They are literal on purpose, so the
// proof outlives zod: a later edit that changes what a schema accepts
// has to change this table too.
//
// Asserts, through the wires' own decode (shared/ipc/codec.ts,
// decodeWith and safeDecodeWith, which must agree):
//   - each ported schema is a Schema, not zod, so the codec takes the
//     Schema path;
//   - valid inputs decode to the zod output: unknown keys stripped at
//     every level, an optional key absent stays absent and an explicit
//     undefined stays an own key, url input trimmed;
//   - invalid inputs are refused: wrong types, missing keys, empty
//     strings under a min length, ports out of range or fractional, an
//     enum value outside the set, a non-web URL (with the refine's
//     message);
//   - a void input decodes undefined and nothing else;
//   - wave 1 (payloads, project, worktree, hygiene, changes,
//     pullRequest, ports, launchers, scripts and the contract slots built
//     inline beside them): every row of RECORDED decodes, or is refused,
//     exactly as zod did, including each refine's message (a leading
//     dash on a git ref, a path leaving the worktree, a commit hash, a
//     clone URL or folder name), each bound, each default and each
//     discriminated union's pick;
//   - the zod copies left for waves 2 and 3 (the `...Zod` exports) give
//     the same verdicts and outputs as the Schema they mirror;
//   - strictStruct (shared/schemas/strict.ts) is z.strictObject: an
//     undeclared key at its level is refused with the key named, a
//     nested plain struct still strips, optional keys and the decoded
//     key set are Schema.Struct's, Schema.is refuses excess keys too,
//     and a `__proto__` key is refused rather than acted on (its types
//     are pinned by test/types/strict-struct.mts under pnpm typecheck);
//   - the v4 constructs the mapping relies on keep the semantics it
//     assumes (Void versus Undefined, Number versus Finite, the two
//     decoding defaults, excess keys stripped by default and refused
//     under onExcessProperty "error", withDecodingDefault's placement,
//     catchDecoding as zod's .catch);
//   - the web stub walker answers a Schema output from its structural
//     candidates, as it did the zod one.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test schema-port.
import assert from "node:assert/strict";
import { Effect, Schema, Struct } from "effect";
import { decodeWith, isZodCodec, safeDecodeWith } from "@shared/ipc/codec";
import { branchesContract } from "@shared/ipc/modules/branches";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { projectsContract } from "@shared/ipc/modules/projects";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { terrierContract } from "@shared/ipc/modules/terrier";
import * as schemas from "@shared/schemas";
import {
  DirectoryListingSchema,
  PickFolderPayloadSchema,
  PortNumberSchema,
  PortNumberZod,
  ShellOpenExternalPayloadSchema,
  TerrierReadinessSchema,
  WorktreePortsResultSchema,
  parsePortNumber,
} from "@shared/schemas";
import { strictStruct } from "@shared/schemas/strict";
import { NO_STRUCTURAL_STUB, stubValueFor } from "../web/ipc/stubDefaults.ts";
import { makeProof } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("schema-port proof");

const ok = (value) => ({ ok: value });
// A refusal, optionally naming text the failure message must carry.
const refuse = (message) => ({ refuse: true, message });

function describe(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return JSON.stringify(value);
}

// One schema against its recorded zod results, through both codec calls.
function assertCases(codec, cases) {
  assert.equal(isZodCodec(codec), false, "the schema is still zod");
  for (const [input, recorded] of cases) {
    const want = recorded.same ? ok(input) : recorded;
    const label = describe(input);
    const safe = safeDecodeWith(codec, input);
    if (want.refuse) {
      assert.equal(safe.success, false, `${label} should be refused`);
      assert.throws(() => decodeWith(codec, input), `${label} should throw`);
      if (want.message !== undefined) {
        assert.match(
          String(safe.error?.message),
          new RegExp(want.message.replace(/[()]/g, "\\$&")),
          `${label} should be refused with "${want.message}"`,
        );
      }
      continue;
    }
    assert.equal(
      safe.success,
      true,
      `${label} should decode: ${safe.error?.message}`,
    );
    assert.deepStrictEqual(safe.data, want.ok, `${label} decoded output`);
    assert.deepStrictEqual(
      decodeWith(codec, input),
      want.ok,
      `${label} decodeWith output`,
    );
  }
}

const hasOwn = (value, key) => Object.hasOwn(value, key);

// A one-row port list.
const row = (fields) => ({ ports: [fields] });

// Wave 1's recorded table: each schema's rows, inputs first, over these
// fixtures. `same` means zod decoded the input to an equal value (no
// key stripped, none added).
const same = { same: true };

const P = { projectId: "p" };
const W = { projectId: "p", worktreeId: "w" };
const H = "abcd1234";
const commit = {
  hash: "abc1234",
  subject: "s",
  author: "a",
  date: "2026-01-01",
  additions: 1,
  deletions: 0,
};
const worktree = {
  id: "w",
  projectId: "p",
  name: "fox",
  branch: "main",
  path: "/x",
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  hasRemote: true,
  divergedClean: false,
  behindPrimary: 0,
  unpushedCount: 0,
  mergedIntoPrimary: false,
  changedCount: 0,
  recentCommits: [commit],
  isPrimary: false,
  isExternal: false,
  detached: false,
  shelved: false,
};
const pr = {
  number: 1,
  url: "https://github.com/a/b/pull/1",
  title: "t",
  state: "OPEN",
  isDraft: false,
};
const checks = {
  total: 1,
  passed: 1,
  failing: 0,
  pending: 0,
  neutral: 0,
  skipped: 0,
};
const detail = {
  ...pr,
  mergeState: "CLEAN",
  baseRefName: "main",
  authorLogin: "me",
  updatedAt: "2026",
  additions: 1,
  deletions: 2,
  changedFiles: 1,
  checks,
  checkList: [
    { name: "ci", bucket: "passed", url: "https://ci.example/1" },
    { name: "lint", bucket: "skipped" },
  ],
};
const candidate = {
  number: 2,
  url: "https://github.com/a/b/pull/2",
  title: "t",
  isDraft: true,
  headRefName: "feat",
  authorLogin: "x",
  fromFork: true,
  headRepo: null,
  updatedAt: "2026",
};
const hyg = {
  worktreeId: "w",
  lastCommitAt: 1,
  headHash: "abcd",
  uniqueCommits: 0,
  contentAlreadyInPrimary: false,
  primaryRef: "main",
  holdsPrimaryBranch: false,
  untracked: false,
};

const RECORDED = {
  ProjectScopedPayloadSchema: [
    [P, same],
    [{ projectId: "p", extra: 1 }, ok({ projectId: "p" })],
    [{ projectId: "" }, refuse()],
    [{}, refuse()],
    [{ projectId: 1 }, refuse()],
    [null, refuse()],
  ],
  WorktreeScopedPayloadSchema: [
    [W, same],
    [{ ...W, extra: 1 }, ok({ projectId: "p", worktreeId: "w" })],
    [P, refuse()],
    [{ ...W, worktreeId: "" }, refuse()],
    [{ ...W, projectId: "" }, refuse()],
  ],
  PathPayloadSchema: [
    [{ path: "/a" }, same],
    [{ path: "/a", x: 1 }, ok({ path: "/a" })],
    [{ path: "" }, refuse()],
    [{}, refuse()],
  ],
  GitRefNameSchema: [
    ["main", same],
    ["feat/x", same],
    ["a-b", same],
    ["", refuse()],
    ["-D", refuse("Branch names cannot start with '-'")],
    ["--track", refuse("Branch names cannot start with '-'")],
    [" -x", same],
    [5, refuse()],
  ],
  ProjectSchema: [
    [{ id: "p", name: "n", path: "/p" }, same],
    [
      {
        id: "p",
        name: "n",
        path: "/p",
        pathExists: false,
        identity: null,
        lastUsed: 0,
        recentCount: 3,
        source: "terrier",
        extra: 1,
      },
      ok({
        id: "p",
        name: "n",
        path: "/p",
        pathExists: false,
        identity: null,
        lastUsed: 0,
        recentCount: 3,
        source: "terrier",
      }),
    ],
    [{ id: "p", name: "n", path: "/p", identity: "github.com/a/b" }, same],
    [
      {
        id: "p",
        name: "n",
        path: "/p",
        identity: undefined,
        pathExists: undefined,
      },
      same,
    ],
    [{ id: "", name: "", path: "" }, same],
    [{ id: "p", name: "n", path: "/p", lastUsed: -1 }, refuse()],
    [{ id: "p", name: "n", path: "/p", recentCount: 1.5 }, refuse()],
    [{ id: "p", name: "n", path: "/p", lastUsed: Infinity }, refuse()],
    [{ id: "p", name: "n", path: "/p", source: "registry" }, refuse()],
    [{ id: "p", name: "n" }, refuse()],
  ],
  ProjectSortModeSchema: [
    ["alphabetical", same],
    ["recent", same],
    ["frequent", same],
    ["manual", same],
    ["name", refuse()],
    ["", refuse()],
  ],
  SidebarViewSchema: [
    ["projects", same],
    ["inbox", same],
    ["tree", refuse()],
  ],
  SetProjectSortPayloadSchema: [
    [{ mode: "recent" }, same],
    [{ mode: "x" }, refuse()],
  ],
  ToggleCollapsedProjectPayloadSchema: [
    [P, same],
    [{ projectId: "" }, refuse()],
  ],
  CloneProjectPayloadSchema: [
    [{ url: "https://github.com/a/b.git", parentDir: "/p" }, same],
    [
      {
        url: "  git@github.com:a/b.git  ",
        parentDir: "/p",
        name: "  foo  ",
        extra: 1,
      },
      ok({ url: "git@github.com:a/b.git", parentDir: "/p", name: "foo" }),
    ],
    [{ url: "https://github.com/a/b", parentDir: "/p", name: undefined }, same],
    [{ url: "/local/repo", parentDir: "/p" }, refuse("Not a git remote URL")],
    [{ url: "file:///x/y", parentDir: "/p" }, refuse("Not a git remote URL")],
    [{ url: "-u", parentDir: "/p" }, refuse("Not a git remote URL")],
    [{ url: "https://github.com/a/b", parentDir: "" }, refuse()],
    [
      { url: "https://github.com/a/b", parentDir: "/p", name: "a/b" },
      refuse("The folder name must be a single path segment"),
    ],
    [
      { url: "https://github.com/a/b", parentDir: "/p", name: "a\\b" },
      refuse("The folder name must be a single path segment"),
    ],
    [
      { url: "https://github.com/a/b", parentDir: "/p", name: "." },
      refuse("The folder name must be a single path segment"),
    ],
    [
      { url: "https://github.com/a/b", parentDir: "/p", name: " .. " },
      refuse("The folder name must be a single path segment"),
    ],
    [{ url: "https://github.com/a/b", parentDir: "/p", name: "   " }, refuse()],
  ],
  RemoveProjectPayloadSchema: [
    [{ id: "p" }, same],
    [{ id: "" }, refuse()],
  ],
  ReorderProjectsPayloadSchema: [
    [{ draggedId: "a", targetId: "b", position: "before" }, same],
    [{ draggedId: "a", targetId: "b", position: "middle" }, refuse()],
    [{ draggedId: "", targetId: "b", position: "after" }, refuse()],
  ],
  ProjectIconSchema: [
    [{ mime: "image/png", base64: "AA==" }, same],
    [{ mime: "image/png" }, refuse()],
  ],
  BranchListSchema: [
    [{ local: ["a"], remote: [] }, same],
    [{ local: [1], remote: [] }, refuse()],
  ],
  CreateBranchPayloadSchema: [
    [{ ...P, name: "x" }, same],
    [{ ...P, name: "x", base: "main" }, same],
    [{ ...P, name: "-x" }, refuse("Branch names cannot start with '-'")],
    [
      { ...P, name: "x", base: "-b" },
      refuse("Branch names cannot start with '-'"),
    ],
    [{ name: "x" }, refuse()],
  ],
  RenameAnyBranchPayloadSchema: [
    [{ ...P, oldName: "a", newName: "b" }, same],
    [
      { ...P, oldName: "a", newName: "-b" },
      refuse("Branch names cannot start with '-'"),
    ],
  ],
  DeleteBranchPayloadSchema: [
    [{ ...P, name: "a", force: true }, same],
    [{ ...P, name: "--force" }, refuse("Branch names cannot start with '-'")],
    [{ ...P, name: "a", force: "yes" }, refuse()],
  ],
  CommitHashSchema: [
    ["abcd", same],
    [H, same],
    ["a".repeat(40), same],
    ["a".repeat(64), same],
    ["a".repeat(65), refuse("Invalid commit hash")],
    ["abc", refuse("Invalid commit hash")],
    ["ABCD", refuse("Invalid commit hash")],
    ["--output=/tmp/x", refuse("Invalid commit hash")],
    [" abcd", refuse("Invalid commit hash")],
    ["", refuse("Invalid commit hash")],
  ],
  CommitSummarySchema: [
    [commit, same],
    [{ ...commit, hash: "zzzz" }, refuse("Invalid commit hash")],
    [{ ...commit, additions: -1 }, refuse()],
    [
      { ...commit, extra: 1 },
      ok({
        hash: "abc1234",
        subject: "s",
        author: "a",
        date: "2026-01-01",
        additions: 1,
        deletions: 0,
      }),
    ],
  ],
  WorktreeSchema: [
    [
      worktree,
      ok({
        id: "w",
        projectId: "p",
        name: "fox",
        branch: "main",
        path: "/x",
        ahead: 0,
        behind: 0,
        hasUpstream: true,
        hasRemote: true,
        divergedClean: false,
        behindPrimary: 0,
        unpushedCount: 0,
        mergedIntoPrimary: false,
        changedCount: 0,
        recentCommits: [
          {
            hash: "abc1234",
            subject: "s",
            author: "a",
            date: "2026-01-01",
            additions: 1,
            deletions: 0,
          },
        ],
        isPrimary: false,
        isExternal: false,
        detached: false,
        shelved: false,
        autoPull: false,
      }),
    ],
    [
      {
        ...worktree,
        autoPull: undefined,
        primaryRef: "origin/main",
        lastChangeAt: 5,
        extra: 1,
      },
      ok({
        id: "w",
        projectId: "p",
        name: "fox",
        branch: "main",
        path: "/x",
        ahead: 0,
        behind: 0,
        hasUpstream: true,
        hasRemote: true,
        divergedClean: false,
        behindPrimary: 0,
        unpushedCount: 0,
        primaryRef: "origin/main",
        mergedIntoPrimary: false,
        changedCount: 0,
        lastChangeAt: 5,
        recentCommits: [
          {
            hash: "abc1234",
            subject: "s",
            author: "a",
            date: "2026-01-01",
            additions: 1,
            deletions: 0,
          },
        ],
        isPrimary: false,
        isExternal: false,
        detached: false,
        shelved: false,
        autoPull: false,
      }),
    ],
    [{ ...worktree, autoPull: true, recentCommits: [] }, same],
    [{ ...worktree, projectId: "" }, refuse()],
    [{ ...worktree, ahead: -1 }, refuse()],
    [{ ...worktree, behind: 0.5 }, refuse()],
    [
      { ...worktree, recentCommits: [{ ...commit, hash: "--x" }] },
      refuse("Invalid commit hash"),
    ],
    [{ ...worktree, autoPull: null }, refuse()],
    [{ ...worktree, shelved: undefined }, refuse()],
  ],
  CreateWorktreePayloadSchema: [
    [P, same],
    [
      {
        ...P,
        worktreeName: "fox",
        branchName: "feat/x",
        base: "main",
        checkout: true,
      },
      same,
    ],
    [{ ...P, worktreeName: "root" }, refuse("Not a valid folder name")],
    [{ ...P, worktreeName: ".." }, refuse("Not a valid folder name")],
    [{ ...P, worktreeName: "a/b" }, refuse("Not a valid folder name")],
    // zod reported the min and the refine; Schema stops at the first
    // failed check, the empty string's.
    [{ ...P, worktreeName: "" }, refuse()],
    [{ ...P, branchName: "-x" }, refuse("Branch names cannot start with '-'")],
    [{ ...P, base: "--orphan" }, refuse("Branch names cannot start with '-'")],
  ],
  CarryOverReportSchema: [
    [{ applied: 0, failures: [] }, same],
    [
      {
        applied: 2,
        failures: [{ path: "a", reason: "r", source: "s", x: 1 }],
        includeFailures: [],
        sourced: [{ path: "a", source: "b", copiedInstead: true }],
      },
      ok({
        applied: 2,
        failures: [{ path: "a", reason: "r", source: "s" }],
        includeFailures: [],
        sourced: [{ path: "a", source: "b", copiedInstead: true }],
      }),
    ],
    [{ applied: -1, failures: [] }, refuse()],
    [{ applied: 0 }, refuse()],
  ],
  CreateWorktreeResultSchema: [
    [
      { worktree },
      ok({
        worktree: {
          id: "w",
          projectId: "p",
          name: "fox",
          branch: "main",
          path: "/x",
          ahead: 0,
          behind: 0,
          hasUpstream: true,
          hasRemote: true,
          divergedClean: false,
          behindPrimary: 0,
          unpushedCount: 0,
          mergedIntoPrimary: false,
          changedCount: 0,
          recentCommits: [
            {
              hash: "abc1234",
              subject: "s",
              author: "a",
              date: "2026-01-01",
              additions: 1,
              deletions: 0,
            },
          ],
          isPrimary: false,
          isExternal: false,
          detached: false,
          shelved: false,
          autoPull: false,
        },
      }),
    ],
    [{ worktree: { ...worktree, id: 1 } }, refuse()],
  ],
  CreatePhaseSchema: [
    ["carryOver", same],
    ["setup", same],
    ["portPoolProvision", same],
    ["idle", refuse()],
  ],
  WorktreeLifecyclePhaseSchema: [
    [{ ...W, phase: "idle" }, same],
    [{ ...W, phase: "setup" }, same],
    [{ ...W, phase: "other" }, refuse()],
  ],
  WorktreeCarryOverCompleteSchema: [
    [{ ...W, report: { applied: 0, failures: [] } }, same],
    [
      {
        ...W,
        report: { applied: 0, failures: [] },
        removedCarryOverPaths: ["x"],
      },
      same,
    ],
    [{ ...W }, refuse()],
  ],
  RelocateWorktreePayloadSchema: [
    [{ ...W, destinationPath: "/d" }, same],
    [{ ...W, destinationPath: "" }, refuse()],
  ],
  DeleteWorktreePayloadSchema: [
    [W, same],
    [
      { ...W, force: true, skipCleanup: false, refuseRunningScripts: true },
      same,
    ],
    [{ ...W, force: 1 }, refuse()],
  ],
  RenameBranchPayloadSchema: [
    [{ ...W, newBranch: "x" }, same],
    [{ ...W, newBranch: "-x" }, refuse("Branch names cannot start with '-'")],
  ],
  SetShelvedPayloadSchema: [
    [{ ...W, shelved: true }, same],
    [W, refuse()],
  ],
  SetAutoPullPayloadSchema: [
    [{ ...W, autoPull: false }, same],
    [W, refuse()],
  ],
  CheckoutBranchPayloadSchema: [
    [{ ...W, branch: "main" }, same],
    [{ ...W, branch: "-main" }, refuse("Branch names cannot start with '-'")],
  ],
  CommitDiffPayloadSchema: [
    [{ ...W, hash: H }, same],
    [{ ...W, hash: "HEAD" }, refuse("Invalid commit hash")],
  ],
  ListCommitsPayloadSchema: [
    [{ ...W, skip: 0, count: 200 }, same],
    [{ ...W, skip: -1, count: 1 }, refuse()],
    [{ ...W, skip: 0, count: 0 }, refuse()],
    [{ ...W, skip: 0, count: 201 }, refuse()],
    [{ ...W, skip: 0.5, count: 1 }, refuse()],
  ],
  CleanupErrorSchema: [
    [{ phase: "teardown", exitCode: 1, runId: "r" }, same],
    [{ phase: "portPoolRelease", exitCode: null, runId: "r" }, same],
    [{ phase: "teardown", exitCode: 1.5, runId: "r" }, same],
    [{ phase: "teardown", exitCode: NaN, runId: "r" }, refuse()],
    [{ phase: "setup", exitCode: 1, runId: "r" }, refuse()],
    [{ phase: "teardown", exitCode: 1, runId: "" }, refuse()],
  ],
  DeleteWorktreeResultSchema: [
    [{ ok: true }, same],
    [
      {
        ok: true,
        cleanupError: { phase: "teardown", exitCode: 1, runId: "r" },
      },
      ok({ ok: true }),
    ],
    [
      {
        ok: false,
        cleanupError: { phase: "teardown", exitCode: null, runId: "r" },
      },
      same,
    ],
    [{ ok: false }, refuse()],
    [{ ok: "true" }, refuse()],
    [{}, refuse()],
  ],
  WorktreeHygieneSchema: [
    [hyg, same],
    [
      {
        ...hyg,
        lastCommitAt: null,
        headHash: null,
        uniqueCommits: null,
        primaryRef: null,
      },
      same,
    ],
    [{ ...hyg, uniqueCommits: -1 }, refuse()],
    [{ ...hyg, lastCommitAt: undefined }, refuse()],
  ],
  WorktreeDiskUsageSchema: [
    [{ worktreeId: "w", bytes: 10, lastActivityAt: null, partial: true }, same],
    [
      { worktreeId: "w", bytes: -1, lastActivityAt: 1, partial: false },
      refuse(),
    ],
  ],
  StagedStateSchema: [
    ["none", same],
    ["partial", same],
    ["all", same],
    ["some", refuse()],
  ],
  ChangeKindSchema: [
    ["added", same],
    ["copied", refuse()],
  ],
  ChangedFileSchema: [
    [{ path: "a", kind: "modified", staged: "none" }, same],
    [
      {
        path: "a",
        kind: "renamed",
        staged: "all",
        prevPath: "b",
        counts: { additions: 1, deletions: 2 },
        conflicted: true,
        x: 1,
      },
      ok({
        path: "a",
        kind: "renamed",
        counts: { additions: 1, deletions: 2 },
        prevPath: "b",
        staged: "all",
        conflicted: true,
      }),
    ],
    [{ path: "a", kind: "added", staged: "none", conflicted: false }, refuse()],
    [{ path: "", kind: "added", staged: "none" }, refuse()],
    [
      { path: "a", kind: "added", staged: "none", counts: { additions: 1 } },
      refuse(),
    ],
  ],
  FileDiffPayloadSchema: [
    [{ ...W, paths: ["a/b.ts"], untracked: false }, same],
    [{ ...W, paths: ["old", "new"], untracked: true }, same],
    [{ ...W, paths: [], untracked: false }, refuse()],
    [
      { ...W, paths: ["../x"], untracked: false },
      refuse("Path must stay within the worktree"),
    ],
    [
      { ...W, paths: ["a/../../x"], untracked: false },
      refuse("Path must stay within the worktree"),
    ],
    [
      { ...W, paths: ["/etc/passwd"], untracked: false },
      refuse("Path must stay within the worktree"),
    ],
    [
      { ...W, paths: ["a\\..\\b"], untracked: false },
      refuse("Path must stay within the worktree"),
    ],
    [
      { ...W, paths: ["a\0b"], untracked: false },
      refuse("Path must stay within the worktree"),
    ],
    [{ ...W, paths: [""], untracked: false }, refuse()],
    [{ ...W, paths: ["-x"], untracked: false }, same],
  ],
  SetStagedPayloadSchema: [
    [{ ...W, paths: ["a"], staged: true }, same],
    [
      { ...W, paths: ["../a"], staged: true },
      refuse("Path must stay within the worktree"),
    ],
  ],
  CommitChangesPayloadSchema: [
    [
      { ...W, summary: "  fix  " },
      ok({ projectId: "p", worktreeId: "w", summary: "fix" }),
    ],
    [
      { ...W, summary: "s", description: "d", stagePaths: [], amend: true },
      same,
    ],
    [{ ...W, summary: "s", stagePaths: ["a", "b"] }, same],
    [{ ...W, summary: "   " }, refuse()],
    [
      { ...W, summary: "s", stagePaths: ["../x"] },
      refuse("Path must stay within the worktree"),
    ],
  ],
  CommitMessageSchema: [
    [{ summary: "s", description: "" }, same],
    [{ summary: "s" }, refuse()],
  ],
  ResetSoftPayloadSchema: [
    [{ ...W, target: H }, same],
    [{ ...W, target: H, expectHead: "abcd" }, same],
    [{ ...W, target: "HEAD~1" }, refuse("Invalid commit hash")],
    [{ ...W, target: H, expectHead: "-x" }, refuse("Invalid commit hash")],
  ],
  ResetSoftResultSchema: [
    [
      { previousHead: H, worktree },
      ok({
        previousHead: "abcd1234",
        worktree: {
          id: "w",
          projectId: "p",
          name: "fox",
          branch: "main",
          path: "/x",
          ahead: 0,
          behind: 0,
          hasUpstream: true,
          hasRemote: true,
          divergedClean: false,
          behindPrimary: 0,
          unpushedCount: 0,
          mergedIntoPrimary: false,
          changedCount: 0,
          recentCommits: [
            {
              hash: "abc1234",
              subject: "s",
              author: "a",
              date: "2026-01-01",
              additions: 1,
              deletions: 0,
            },
          ],
          isPrimary: false,
          isExternal: false,
          detached: false,
          shelved: false,
          autoPull: false,
        },
      }),
    ],
    [{ previousHead: "x", worktree }, refuse("Invalid commit hash")],
  ],
  CommitChangesResultSchema: [
    [
      { hash: H, worktree },
      ok({
        hash: "abcd1234",
        worktree: {
          id: "w",
          projectId: "p",
          name: "fox",
          branch: "main",
          path: "/x",
          ahead: 0,
          behind: 0,
          hasUpstream: true,
          hasRemote: true,
          divergedClean: false,
          behindPrimary: 0,
          unpushedCount: 0,
          mergedIntoPrimary: false,
          changedCount: 0,
          recentCommits: [
            {
              hash: "abc1234",
              subject: "s",
              author: "a",
              date: "2026-01-01",
              additions: 1,
              deletions: 0,
            },
          ],
          isPrimary: false,
          isExternal: false,
          detached: false,
          shelved: false,
          autoPull: false,
        },
      }),
    ],
  ],
  DiscardChangesPayloadSchema: [
    [{ ...W, paths: ["a"] }, same],
    [{ ...W, paths: [] }, refuse()],
    [{ ...W, paths: ["/a"] }, refuse("Path must stay within the worktree")],
  ],
  DiscardChangesResultSchema: [
    [
      { snapshot: H, worktree },
      ok({
        snapshot: "abcd1234",
        worktree: {
          id: "w",
          projectId: "p",
          name: "fox",
          branch: "main",
          path: "/x",
          ahead: 0,
          behind: 0,
          hasUpstream: true,
          hasRemote: true,
          divergedClean: false,
          behindPrimary: 0,
          unpushedCount: 0,
          mergedIntoPrimary: false,
          changedCount: 0,
          recentCommits: [
            {
              hash: "abc1234",
              subject: "s",
              author: "a",
              date: "2026-01-01",
              additions: 1,
              deletions: 0,
            },
          ],
          isPrimary: false,
          isExternal: false,
          detached: false,
          shelved: false,
          autoPull: false,
        },
      }),
    ],
    [{ snapshot: "", worktree }, refuse("Invalid commit hash")],
  ],
  RestoreDiscardPayloadSchema: [
    [{ ...W, snapshot: H }, same],
    [{ ...W, snapshot: "zz" }, refuse("Invalid commit hash")],
  ],
  PullRequestSchema: [
    [pr, same],
    [
      { ...pr, url: "  https://github.com/a/b/pull/1  ", extra: 1 },
      ok({
        number: 1,
        url: "https://github.com/a/b/pull/1",
        title: "t",
        state: "OPEN",
        isDraft: false,
      }),
    ],
    [{ ...pr, url: "mailto:a@b.c" }, same],
    [{ ...pr, url: "not a url" }, refuse()],
    [{ ...pr, url: "http://" }, refuse()],
    [{ ...pr, number: 0 }, refuse()],
    [{ ...pr, number: 1.5 }, refuse()],
    [{ ...pr, state: "DRAFT" }, refuse()],
  ],
  PullRequestCheckSchema: [
    [{ name: "c", bucket: "failing" }, same],
    [
      { name: "c", bucket: "failing", url: " https://x.y/z " },
      ok({ name: "c", bucket: "failing", url: "https://x.y/z" }),
    ],
    [{ name: "c", bucket: "failing", url: "" }, refuse()],
    [{ name: "c", bucket: "red" }, refuse()],
  ],
  PullRequestChecksSummarySchema: [
    [checks, same],
    [{ ...checks, total: -1 }, refuse()],
  ],
  PullRequestDetailSchema: [
    [detail, same],
    [{ ...detail, mergeState: "WHATEVER" }, refuse()],
    [
      { ...detail, checkList: [{ name: "c", bucket: "passed", url: "nope" }] },
      refuse(),
    ],
    [pr, refuse()],
  ],
  MergeMethodSchema: [
    ["merge", same],
    ["squash", same],
    ["rebase", same],
    ["ff", refuse()],
  ],
  RepoMergeConfigSchema: [
    [{ merge: true, squash: false, rebase: true }, same],
    [{ merge: true }, refuse()],
  ],
  GithubCliReadinessSchema: [
    [{ installed: true, authed: false }, same],
    [{ installed: true }, refuse()],
  ],
  PullRequestCandidateSchema: [
    [candidate, same],
    [{ ...candidate, headRepo: "me/fork", fromFork: true }, same],
    [{ ...candidate, headRefName: "" }, refuse()],
    [{ ...candidate, url: "x" }, refuse()],
  ],
  GhUnavailableReasonSchema: [
    ["integration-off", same],
    ["gh-missing", same],
    ["gh-signed-out", same],
    ["gh-failed", refuse()],
  ],
  PullRequestSourceUnavailableSchema: [
    ["integration-off", same],
    ["gh-missing", same],
    ["gh-signed-out", same],
    ["no-github-remote", same],
    ["gh-failed", same],
    ["other", refuse()],
  ],
  PullRequestCandidateListSchema: [
    [{ status: "ok", pullRequests: [candidate] }, same],
    [
      { status: "ok", pullRequests: [], reason: "gh-failed" },
      ok({ status: "ok", pullRequests: [] }),
    ],
    [{ status: "unavailable", reason: "no-github-remote" }, same],
    [{ status: "unavailable", reason: "nope" }, refuse()],
    [{ status: "ok" }, refuse()],
    [{ status: "other" }, refuse()],
  ],
  ResolvePullRequestCheckoutPayloadSchema: [
    [{ ...P, number: 3 }, same],
    [{ ...P, number: 0 }, refuse()],
    [{ number: 3 }, refuse()],
  ],
  PullRequestCheckoutRefSchema: [
    [{ branch: "pr/3" }, same],
    [{ branch: "" }, refuse()],
  ],
  GithubCliWorktreePullRequestPayloadSchema: [
    [{ ...P, branch: "b" }, same],
    [{ ...P, branch: "" }, refuse()],
  ],
  GithubCliPullRequestDiffPayloadSchema: [
    [{ ...P, number: 1 }, same],
    [{ ...P, number: -1 }, refuse()],
  ],
  MergePullRequestPayloadSchema: [
    [{ ...P, number: 1, method: "squash" }, same],
    [{ ...P, number: 1, method: "fast-forward" }, refuse()],
  ],
  SetPullRequestDraftPayloadSchema: [
    [{ ...P, number: 1, draft: true }, same],
    [{ ...P, number: 1 }, refuse()],
  ],
  CustomPortSchema: [
    [{ port: 3000 }, same],
    [{ port: 3000, label: "  api  ", x: 1 }, ok({ port: 3000, label: "api" })],
    [{ port: 3000, label: "a".repeat(32) }, same],
    [{ port: 3000, label: "a".repeat(33) }, refuse()],
    [{ port: 3000, label: "   " }, refuse()],
    [{ port: 0 }, refuse()],
    [{ port: 3000.5 }, refuse()],
    [{ port: 3000, label: undefined }, same],
  ],
  DetectedLauncherSchema: [
    [{ kind: "detected", id: "code", label: "Code", available: true }, same],
    [{ kind: "detected", id: "code", label: "Code" }, refuse()],
  ],
  LauncherEntrySchema: [
    [
      { kind: "detected", id: "code", label: "Code", available: false, x: 1 },
      ok({ kind: "detected", id: "code", label: "Code", available: false }),
    ],
    [{ kind: "custom", id: "c", label: "C" }, same],
    [{ kind: "web", id: "web:github", label: "GitHub" }, same],
    [
      { kind: "custom", id: "c", label: "C", available: true },
      ok({ kind: "custom", id: "c", label: "C" }),
    ],
    [{ kind: "app", id: "a", label: "A" }, refuse()],
    [{ kind: "detected", id: "code", label: "Code" }, refuse()],
  ],
  LaunchPayloadSchema: [
    [{ ...W, launcherId: "app:code" }, same],
    [{ ...W, launcherId: "" }, refuse()],
  ],
  SetLaunchToolsEnabledPayloadSchema: [
    [{ enabled: false }, same],
    [
      { enabled: true, entries: [{ id: "a", label: "A", x: 1 }] },
      ok({ enabled: true, entries: [{ id: "a", label: "A" }] }),
    ],
    [{ enabled: true, entries: [{ id: "a" }] }, refuse()],
  ],
  RunScriptPayloadSchema: [
    [{ ...W, script: "setup" }, same],
    [{ ...W, script: "port-pool-release" }, same],
    [{ ...W, script: "dev" }, refuse()],
  ],
  PackageScriptsResultSchema: [
    [
      {
        scripts: { dev: "vite" },
        packageManager: "pnpm",
        usage: { dev: { lastUsed: 0, recentCount: 0 } },
      },
      same,
    ],
    [{ scripts: {}, packageManager: "deno", usage: {} }, refuse()],
    [{ scripts: { dev: 1 }, packageManager: "pnpm", usage: {} }, refuse()],
    [
      {
        scripts: {},
        packageManager: "bun",
        usage: { dev: { lastUsed: -1, recentCount: 0 } },
      },
      refuse(),
    ],
  ],
  PackageScriptSortModeSchema: [
    ["manifest", same],
    ["alphabetical", same],
    ["recent", same],
    ["frequent", same],
    ["manual", refuse()],
  ],
  RunPackageScriptPayloadSchema: [
    [{ ...W, scriptName: "dev" }, same],
    [{ ...W, scriptName: "" }, refuse()],
  ],
  SetPackageScriptSortPayloadSchema: [
    [{ ...P, mode: "manifest" }, same],
    [{ ...P, mode: "manual" }, refuse()],
  ],
  CancelScriptPayloadSchema: [
    [{ runId: "r" }, same],
    [{ runId: "" }, refuse()],
  ],
  WriteScriptPayloadSchema: [
    [{ runId: "r", data: "" }, same],
    [{ runId: "r" }, refuse()],
  ],
  ResizeScriptPayloadSchema: [
    [{ runId: "r", cols: 80, rows: 24 }, same],
    [{ runId: "r", cols: 0, rows: 24 }, refuse()],
    [{ runId: "r", cols: 80.5, rows: 24 }, refuse()],
  ],
  ScriptEventSchema: [
    [{ runId: "r", kind: "data", data: "x" }, same],
    [{ runId: "r", kind: "exit", code: null }, same],
    [{ runId: "r", kind: "exit", code: 0 }, same],
    [{ runId: "r", kind: "error", data: "boom" }, same],
    [
      {
        runId: "r",
        kind: "started",
        projectId: "p",
        worktreeId: "w",
        slot: { kind: "setup" },
      },
      same,
    ],
    [
      {
        runId: "r",
        kind: "started",
        projectId: "p",
        worktreeId: "w",
        slot: { kind: "portPool", phase: "release", x: 1 },
      },
      ok({
        runId: "r",
        kind: "started",
        projectId: "p",
        worktreeId: "w",
        slot: { kind: "portPool", phase: "release" },
      }),
    ],
    [
      {
        runId: "r",
        kind: "started",
        projectId: "p",
        worktreeId: "w",
        slot: { kind: "portPool" },
      },
      refuse(),
    ],
    [
      {
        runId: "r",
        kind: "started",
        projectId: "p",
        worktreeId: "w",
        slot: { kind: "dev" },
      },
      refuse(),
    ],
    [{ runId: "r", kind: "exit" }, refuse()],
    [{ runId: "r", kind: "stdout", data: "x" }, refuse()],
    [
      { runId: "r", kind: "data", data: "x", code: 1 },
      ok({ runId: "r", kind: "data", data: "x" }),
    ],
  ],
  RemovedWorktreeScriptsSchema: [
    [{ worktreeId: "w", worktreeName: "n", scriptCount: 1 }, same],
    [{ worktreeId: "w", worktreeName: "n", scriptCount: 0 }, refuse()],
  ],
  OrphanScriptReportSchema: [
    [{ stopped: 0 }, same],
    [{ stopped: -1 }, refuse()],
  ],
};

// The zod copies the unported embedders still hold, beside the Schema
// each mirrors (Phase 4 waves 2 and 3 delete them).
const ZOD_COPIES = [
  ["ProjectScopedPayloadZod", "ProjectScopedPayloadSchema"],
  ["GitRefNameZod", "GitRefNameSchema"],
  ["SidebarViewZod", "SidebarViewSchema"],
  ["CommitHashZod", "CommitHashSchema"],
  ["CreatePhaseZod", "CreatePhaseSchema"],
  ["WorktreeZod", "WorktreeSchema"],
  ["MergeMethodZod", "MergeMethodSchema"],
  ["CustomPortZod", "CustomPortSchema"],
];

// Whether a Schema decodes the input, for the construct checks.
const decodes = (schema, input, options) =>
  Schema.decodeUnknownExit(schema, options)(input)._tag === "Success";

async function main() {
  await check("PickFolderPayloadSchema matches zod", () => {
    const full = {
      title: "T",
      buttonLabel: "B",
      message: "M",
      defaultPath: "/x",
    };
    assertCases(PickFolderPayloadSchema, [
      // The whole payload is optional (zod's .optional() on the object).
      [undefined, ok(undefined)],
      [{}, ok({})],
      [full, ok(full)],
      [{ title: "T", extra: 1 }, ok({ title: "T" })],
      [{ title: undefined }, ok({ title: undefined })],
      [{ title: "" }, refuse()],
      [{ title: 1 }, refuse()],
      [null, refuse()],
      ["x", refuse()],
      [[], refuse()],
    ]);
    // Absent stays absent, explicit undefined stays an own key.
    assert.equal(
      hasOwn(decodeWith(PickFolderPayloadSchema, {}), "title"),
      false,
    );
    assert.equal(
      hasOwn(
        decodeWith(PickFolderPayloadSchema, { title: undefined }),
        "title",
      ),
      true,
    );
  });

  await check("DirectoryListingSchema matches zod", () => {
    assertCases(DirectoryListingSchema, [
      [{ path: "/a", entries: [] }, ok({ path: "/a", entries: [] })],
      [
        {
          path: "/a",
          entries: [{ name: "x", isGitRepo: true, junk: 1 }],
          extra: 2,
        },
        ok({ path: "/a", entries: [{ name: "x", isGitRepo: true }] }),
      ],
      [{ path: "/a" }, refuse()],
      [{ path: "/a", entries: [{ name: "x" }] }, refuse()],
      [{ path: "/a", entries: {} }, refuse()],
      [{ path: 1, entries: [] }, refuse()],
      [undefined, refuse()],
    ]);
  });

  await check("ShellOpenExternalPayloadSchema matches zod", () => {
    const WEB_ONLY = "Only http(s) URLs can be opened";
    assertCases(ShellOpenExternalPayloadSchema, [
      [{ url: "https://example.com" }, ok({ url: "https://example.com" })],
      [
        { url: "http://localhost:3000/x?y=1" },
        ok({ url: "http://localhost:3000/x?y=1" }),
      ],
      // zod's url check trimmed its output; the handler opens the trimmed URL.
      [{ url: "  https://example.com  " }, ok({ url: "https://example.com" })],
      [
        { url: "\thttps://example.com/\n" },
        ok({ url: "https://example.com/" }),
      ],
      [{ url: "http:example.com" }, ok({ url: "http:example.com" })],
      [{ url: "HTTPS://EXAMPLE.COM" }, ok({ url: "HTTPS://EXAMPLE.COM" })],
      [
        { url: "https://example.com", extra: 1 },
        ok({ url: "https://example.com" }),
      ],
      [{ url: "file:///etc/passwd" }, refuse(WEB_ONLY)],
      [{ url: "javascript:alert(1)" }, refuse(WEB_ONLY)],
      [{ url: "mailto:a@b.c" }, refuse(WEB_ONLY)],
      [{ url: "not a url" }, refuse()],
      [{ url: "" }, refuse()],
      [{ url: "http://" }, refuse()],
      [{}, refuse()],
      [{ url: 5 }, refuse()],
    ]);
  });

  await check("TerrierReadinessSchema matches zod", () => {
    assertCases(TerrierReadinessSchema, [
      [
        { installed: true, compatible: true, version: "0.4.1" },
        ok({ installed: true, compatible: true, version: "0.4.1" }),
      ],
      [
        { installed: false, compatible: false },
        ok({ installed: false, compatible: false }),
      ],
      [
        { installed: true, compatible: false, version: undefined },
        ok({ installed: true, compatible: false, version: undefined }),
      ],
      [
        { installed: true, compatible: true, extra: 1 },
        ok({ installed: true, compatible: true }),
      ],
      [{ installed: true, compatible: true, version: null }, refuse()],
      [{ installed: "yes", compatible: true }, refuse()],
      [{}, refuse()],
    ]);
    const absent = decodeWith(TerrierReadinessSchema, {
      installed: false,
      compatible: false,
    });
    assert.equal(
      hasOwn(absent, "version"),
      false,
      "absent version stays absent",
    );
  });

  await check("terrier:readiness's void input decodes undefined only", () => {
    assertCases(terrierContract.calls.readiness.input, [
      [undefined, ok(undefined)],
      [null, refuse()],
      [{}, refuse()],
      [0, refuse()],
      ["", refuse()],
    ]);
  });

  await check("WorktreePortsResultSchema matches zod", () => {
    assertCases(WorktreePortsResultSchema, [
      [{ ports: [] }, ok({ ports: [] })],
      [
        row({ port: 3000, label: "web", source: "pool", listening: true }),
        ok(row({ port: 3000, label: "web", source: "pool", listening: true })),
      ],
      [
        {
          ports: [{ port: 3000, source: "custom", listening: false, extra: 1 }],
          extra: 2,
        },
        ok(row({ port: 3000, source: "custom", listening: false })),
      ],
      [
        row({ port: 3000, label: "", source: "pool", listening: true }),
        ok(row({ port: 3000, label: "", source: "pool", listening: true })),
      ],
      [
        row({ port: 3000, label: undefined, source: "pool", listening: true }),
        ok(
          row({
            port: 3000,
            label: undefined,
            source: "pool",
            listening: true,
          }),
        ),
      ],
      [row({ port: 3000, source: "other", listening: true }), refuse()],
      [row({ port: 0, source: "pool", listening: true }), refuse()],
      [row({ port: 65536, source: "pool", listening: true }), refuse()],
      [row({ port: 3000.5, source: "pool", listening: true }), refuse()],
      [row({ port: Number.NaN, source: "pool", listening: true }), refuse()],
      [row({ port: Infinity, source: "pool", listening: true }), refuse()],
      [row({ port: "3000", source: "pool", listening: true }), refuse()],
      [{}, refuse()],
      [row({ port: 3000, source: "pool" }), refuse()],
    ]);
  });

  await check("parsePortNumber matches zod's PortNumberSchema", () => {
    const recorded = {
      3000: 3000,
      "": undefined,
      0: undefined,
      65536: undefined,
      "1e3": 1000,
      " 80 ": 80,
      "0x50": 80,
      abc: undefined,
      1.5: undefined,
      65535: 65535,
      1: 1,
      "-1": undefined,
      Infinity: undefined,
    };
    for (const [raw, want] of Object.entries(recorded)) {
      assert.equal(parsePortNumber(raw), want, `parsePortNumber(${raw})`);
      const viaSchema = safeDecodeWith(PortNumberSchema, Number(raw));
      assert.equal(
        viaSchema.success ? viaSchema.data : undefined,
        want,
        `PortNumberSchema on ${raw}`,
      );
      // The zod copy still embedded by config.ts and the forward
      // contracts must agree with the Schema form while both exist.
      const viaZod = PortNumberZod.safeParse(Number(raw));
      assert.equal(
        viaZod.success ? viaZod.data : undefined,
        want,
        `PortNumberZod on ${raw}`,
      );
    }
  });

  for (const [name, rows] of Object.entries(RECORDED)) {
    // oxlint-disable-next-line no-await-in-loop -- one named check per schema, in table order
    await check(`${name} matches zod`, () => {
      assertCases(schemas[name], rows);
    });
  }

  await check("the zod copies agree with the Schema they mirror", () => {
    for (const [copyName, schemaName] of ZOD_COPIES) {
      const copy = schemas[copyName];
      assert.equal(isZodCodec(copy), true, `${copyName} is zod`);
      for (const [input] of RECORDED[schemaName]) {
        const viaCopy = copy.safeParse(input);
        const viaSchema = safeDecodeWith(schemas[schemaName], input);
        const label = `${copyName} on ${describe(input)}`;
        assert.equal(viaCopy.success, viaSchema.success, label);
        if (viaCopy.success) {
          assert.deepStrictEqual(viaCopy.data, viaSchema.data, label);
        }
      }
    }
  });

  await check("wave 1's inline contract slots match zod", () => {
    assertCases(gitContract.calls.fetchActive.payload, [
      [
        { projectId: "p", active: true, x: 1 },
        ok({ projectId: "p", active: true }),
      ],
      [{ projectId: "p" }, refuse()],
      [{ projectId: "", active: false }, refuse()],
    ]);
    assertCases(gitContract.calls.sweep.output, [
      [{ leaseMs: 5 }, same],
      [{ leaseMs: Number.NaN }, refuse()],
      [{}, refuse()],
    ]);
    assertCases(gitContract.calls.sweep.input, [
      [undefined, ok(undefined)],
      [null, refuse()],
      [{}, refuse()],
    ]);
    assertCases(branchesContract.calls.create.output, [
      [undefined, ok(undefined)],
      [null, refuse()],
    ]);
    assertCases(launchersContract.calls.forProject.output, [
      [
        { entries: [{ kind: "custom", id: "c", label: "C" }], hiddenCount: 0 },
        same,
      ],
      [{ entries: [], hiddenCount: -1 }, refuse()],
      [{ entries: [], hiddenCount: 1.5 }, refuse()],
    ]);
    assertCases(githubCliContract.calls.projectPullRequests.output, [
      [{}, same],
      [{ main: pr }, same],
      [{ main: { ...pr, extra: 1 } }, ok({ main: pr })],
      [{ main: {} }, refuse()],
    ]);
    assertCases(githubCliContract.calls.worktreePullRequest.output, [
      [null, same],
      [detail, same],
      [undefined, refuse()],
    ]);
    assertCases(projectsContract.calls.icon.output, [
      [null, same],
      [{ mime: "m", base64: "b" }, same],
      [undefined, refuse()],
    ]);
    assertCases(projectsContract.calls.cloneUrl.output, [
      [null, same],
      ["x", same],
      [undefined, refuse()],
    ]);
    assertCases(projectsContract.calls.list.output, [
      [[], same],
      [
        [{ id: "p", name: "n", path: "/p", extra: 1 }],
        ok([{ id: "p", name: "n", path: "/p" }]),
      ],
      [{}, refuse()],
    ]);
    assertCases(scriptsContract.calls.cancel.output, [
      [{ cancelled: true }, same],
      [{}, refuse()],
    ]);
  });

  await check(
    "the web stub walker answers a Schema output structurally",
    () => {
      const structural = { fabricateArms: false };
      assert.deepStrictEqual(
        stubValueFor(projectsContract.calls.list.output, structural),
        [],
      );
      assert.equal(
        stubValueFor(projectsContract.calls.icon.output, structural),
        null,
      );
      assert.equal(
        stubValueFor(branchesContract.calls.create.output, structural),
        undefined,
      );
      // A struct with required members is the zod walker's recursive
      // build, which does not read Schema yet (wave 4): no stub rather
      // than an invented one.
      assert.equal(
        stubValueFor(schemas.GithubCliReadinessSchema, structural),
        NO_STRUCTURAL_STUB,
      );
      assert.equal(
        stubValueFor(schemas.PullRequestCandidateListSchema, {
          fabricateArms: true,
        }),
        NO_STRUCTURAL_STUB,
      );
    },
  );

  await check("strictStruct refuses what z.strictObject refused", () => {
    const Strict = strictStruct({
      name: Schema.NonEmptyString,
      note: Schema.optional(Schema.String),
      inner: Schema.optional(Schema.Struct({ x: Schema.Number })),
    });
    // Recorded against z.strictObject({ name: z.string().min(1),
    // note: z.string().optional(), inner: z.object({ x: z.number() })
    // .optional() }), except the two rows marked below.
    assertCases(Strict, [
      [{ name: "n" }, ok({ name: "n" })],
      [{ name: "n", note: "m" }, ok({ name: "n", note: "m" })],
      [{ name: "n", note: undefined }, ok({ name: "n", note: undefined })],
      // Strict at its own level only: the nested plain struct strips.
      [
        { name: "n", inner: { x: 1, junk: 2 } },
        ok({ name: "n", inner: { x: 1 } }),
      ],
      [{ name: "n", socketHost: {} }, refuse('Unexpected key "socketHost"')],
      [
        { name: "n", note: "m", extra: undefined },
        refuse('Unexpected key "extra"'),
      ],
      [{ name: "" }, refuse()],
      [{ name: "n", note: 1 }, refuse()],
      [{ name: "n", inner: { x: "1" } }, refuse()],
      [{}, refuse()],
      [null, refuse()],
      [[], refuse()],
      ["x", refuse()],
      // zod skipped an own `__proto__` key (JSON.parse makes one) and
      // accepted; the strict struct refuses it.
      [
        JSON.parse('{"name":"n","__proto__":{"polluted":true}}'),
        refuse('Unexpected key "__proto__"'),
      ],
      // zod's for-in also refused an inherited enumerable key; only own
      // keys arrive over a wire, and the decoded value is a fresh object
      // with none of the prototype's keys.
      [
        Object.assign(Object.create({ inherited: 1 }), { name: "n" }),
        ok({ name: "n" }),
      ],
    ]);
    assert.equal({}.polluted, undefined, "Object.prototype untouched");

    // The refusal is the issue onExcessProperty "error" raises, at the
    // key's path, and names the key in the message.
    const refused = safeDecodeWith(Strict, { name: "n", socketHost: 1 });
    assert.equal(
      refused.error?.message,
      'Unexpected key "socketHost"\n  at ["socketHost"]',
    );
    // Every excess key under errors "all", the first one otherwise.
    const twoExtra = { name: "n", b: 1, a: 2 };
    assert.throws(
      () => Schema.decodeUnknownSync(Strict, { errors: "all" })(twoExtra),
      (error) =>
        error.message ===
        'Unexpected key "b"\n  at ["b"]\nUnexpected key "a"\n  at ["a"]',
    );
    assert.throws(
      () => decodeWith(Strict, twoExtra),
      (error) => error.message === 'Unexpected key "b"\n  at ["b"]',
    );

    // The decoded value carries exactly the declared keys it was given:
    // an absent optional stays absent, an explicit undefined stays own.
    assert.deepStrictEqual(
      Object.keys(decodeWith(Strict, { name: "n", inner: { x: 1 } })),
      ["name", "inner"],
    );
    assert.deepStrictEqual(Object.keys(decodeWith(Strict, { name: "n" })), [
      "name",
    ]);
    assert.deepStrictEqual(
      Object.keys(decodeWith(Strict, { name: "n", note: undefined })),
      ["name", "note"],
    );

    // Schema.is refuses an excess key too, so a guard cannot pass a
    // value that still carries it. It checks, it does not strip: a
    // nested plain struct's junk is fine.
    const isStrict = Schema.is(Strict);
    assert.equal(isStrict({ name: "n" }), true);
    assert.equal(isStrict({ name: "n", inner: { x: 1, junk: 2 } }), true);
    assert.equal(isStrict({ name: "n", socketHost: {} }), false);
    assert.equal(
      isStrict(JSON.parse('{"name":"n","__proto__":{"polluted":true}}')),
      false,
    );
    assert.equal(isStrict({ name: "" }), false);

    // Nested in a plain struct, the strict level still refuses (the path
    // runs through the outer key) and the outer level still strips.
    const Outer = Schema.Struct({ patch: Strict });
    assert.deepStrictEqual(
      decodeWith(Outer, { patch: { name: "n" }, junk: 1 }),
      { patch: { name: "n" } },
    );
    assert.equal(
      safeDecodeWith(Outer, { patch: { name: "n", socketHost: 1 } }).error
        ?.message,
      'Unexpected key "socketHost"\n  at ["patch"]["socketHost"]',
    );
    // A union of strict members keeps its literal discrimination.
    const Tagged = Schema.Union([
      strictStruct({ kind: Schema.Literal("a"), x: Schema.String }),
      strictStruct({ kind: Schema.Literal("b"), y: Schema.String }),
    ]);
    assert.deepStrictEqual(decodeWith(Tagged, { kind: "b", y: "1" }), {
      kind: "b",
      y: "1",
    });
    assert.equal(
      safeDecodeWith(Tagged, { kind: "b", y: "1", x: "1" }).success,
      false,
    );

    // Defaults and field checks behave as in Schema.Struct.
    const Defaulted = strictStruct({
      mode: Schema.String.pipe(
        Schema.optional,
        Schema.withDecodingDefault(Effect.succeed("d")),
      ),
      url: ShellOpenExternalPayloadSchema.fields.url,
    });
    assert.deepStrictEqual(decodeWith(Defaulted, { url: " https://a.b " }), {
      mode: "d",
      url: "https://a.b",
    });
    assert.equal(
      safeDecodeWith(Defaulted, { url: "file:///x" }).success,
      false,
    );

    // `fields` is the input, and survives a rebuild; the strictness
    // survives an annotation.
    const annotated = Strict.annotate({ title: "Strict" });
    assert.equal(annotated.fields, Strict.fields);
    assert.equal(safeDecodeWith(annotated, { name: "n", b: 1 }).success, false);

    // The pick recipe (z.strictObject(X.pick({...}).shape)): pick the
    // fields, then make them strict. An unpicked key is refused.
    const Base = Schema.Struct({
      keep: Schema.optional(Schema.Boolean),
      secret: Schema.optional(Schema.String),
    });
    const Patch = strictStruct(Struct.pick(Base.fields, ["keep"]));
    assert.deepStrictEqual(decodeWith(Patch, { keep: true }), { keep: true });
    assert.throws(
      () => decodeWith(Patch, { keep: true, secret: "t" }),
      /Unexpected key "secret"/,
    );
  });

  await check(
    "the v4 constructs keep the semantics the mapping assumes",
    () => {
      // z.void() refuses a present value; Schema.Void discards it, so the
      // port uses Schema.Undefined.
      assert.equal(
        decodes(Schema.Void, {}),
        true,
        "Void accepts a present value",
      );
      assert.equal(decodes(Schema.Undefined, {}), false);
      assert.equal(decodes(Schema.Undefined, undefined), true);
      // zod 4's z.number() refuses NaN and the infinities; Schema.Number
      // takes them, Schema.Finite does not. Schema.Int refuses them too.
      for (const n of [Number.NaN, Infinity, -Infinity]) {
        assert.equal(decodes(Schema.Number, n), true, `Number takes ${n}`);
        assert.equal(decodes(Schema.Finite, n), false, `Finite refuses ${n}`);
        assert.equal(decodes(Schema.Int, n), false, `Int refuses ${n}`);
      }
      // z.object strips unknown keys; so does a Struct under the default
      // parse options, and onExcessProperty "error" is z.strictObject.
      const struct = Schema.Struct({ a: Schema.String });
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(struct)({ a: "x", b: 1 }),
        { a: "x" },
      );
      assert.equal(
        decodes(struct, { a: "x", b: 1 }, { onExcessProperty: "error" }),
        false,
      );
      // zod's .default(x) fills an absent key and an explicit undefined:
      // withDecodingDefault does both, withDecodingDefaultKey only the
      // absent key.
      const withDefault = Schema.Struct({
        a: Schema.String.pipe(
          Schema.optional,
          Schema.withDecodingDefault(Effect.succeed("d")),
        ),
      });
      const withKeyDefault = Schema.Struct({
        a: Schema.String.pipe(
          Schema.optionalKey,
          Schema.withDecodingDefaultKey(Effect.succeed("d")),
        ),
      });
      const decode = Schema.decodeUnknownSync;
      assert.deepStrictEqual(decode(withDefault)({}), { a: "d" });
      assert.deepStrictEqual(decode(withDefault)({ a: undefined }), { a: "d" });
      assert.deepStrictEqual(decode(withDefault)({ a: "x" }), { a: "x" });
      assert.equal(decodes(withDefault, { a: null }), false);
      assert.deepStrictEqual(decode(withKeyDefault)({}), { a: "d" });
      assert.equal(decodes(withKeyDefault, { a: undefined }), false);
      // withDecodingDefault straight on the field decodes the same. It
      // is the form the ports use: after Schema.optional the decoded
      // TYPE keeps the key optional (`a?: string`), where zod's
      // .default() made it required.
      const withDirectDefault = Schema.Struct({
        a: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d"))),
      });
      assert.deepStrictEqual(decode(withDirectDefault)({}), { a: "d" });
      assert.deepStrictEqual(decode(withDirectDefault)({ a: undefined }), {
        a: "d",
      });
      assert.equal(decodes(withDirectDefault, { a: null }), false);
      // zod's .catch(x) replaces any failure, a missing key included.
      // catchDecoding alone does not see a missing key; a decoding
      // default beside it does.
      const caught = Schema.Literals(["A", "Z"]).pipe(
        Schema.catchDecoding(() => Effect.succeedSome("Z")),
      );
      const caughtStruct = Schema.Struct({ m: caught });
      assert.deepStrictEqual(decode(caughtStruct)({ m: "nope" }), { m: "Z" });
      assert.equal(decodes(caughtStruct, {}), false);
      const caughtOrMissing = Schema.Struct({
        m: caught.pipe(Schema.withDecodingDefault(Effect.succeed("Z"))),
      });
      assert.deepStrictEqual(decode(caughtOrMissing)({}), { m: "Z" });
      assert.deepStrictEqual(decode(caughtOrMissing)({ m: null }), { m: "Z" });
      assert.deepStrictEqual(decode(caughtOrMissing)({ m: "A" }), { m: "A" });
      // .optional() on a key is Schema.optional (absent or undefined);
      // Schema.optionalKey refuses an explicit undefined.
      const optionalKey = Schema.Struct({
        a: Schema.optionalKey(Schema.String),
      });
      assert.equal(decodes(optionalKey, {}), true);
      assert.equal(decodes(optionalKey, { a: undefined }), false);
      // z.string().trim().min(1).max(n): Schema.Trim trims before its checks.
      const trimmed = Schema.Trim.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(3),
      );
      assert.equal(decode(trimmed)("  abc  "), "abc");
      assert.equal(decodes(trimmed, "   "), false);
      assert.equal(decodes(trimmed, " abcd "), false);
    },
  );

  done();
}

main().catch(fail);
