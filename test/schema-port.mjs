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
//   - each ported schema is a Schema;
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
//   - wave 2 (config, runtime, sharedSettings and every contract slot
//     that embeds them or held zod: globalConfig, runtime,
//     sharedSettings, updater, clientConfig, projectLauncher, cli, nav,
//     window, shigomori, account, hub, and projects' carry-over
//     outputs): every row of RECORDED_WAVE2 decodes, or is refused,
//     exactly as zod did, including the carry-over path refine's
//     message, every bound, the loose stored documents keeping unknown
//     keys at their own level only, and each void slot taking undefined
//     alone;
//   - the remote device-settings patch refuses `socketHost` (and every
//     other key the Settings form does not manage) by name, at every
//     level it rides, and through Schema.is, while its picked keys are
//     the full config's own field schemas;
//   - the shared settings document reads entry by entry as the zod
//     transform did: a bad key or entry is left out without costing the
//     rest, the first 512 readable entries in the document's own order
//     are kept, and a `__proto__` key is dropped with the prototype
//     untouched, since every device must run the same rule;
//   - wave 3 (the wire layer: the sync, mirror, control, forward,
//     portForward, direct and remoteAccess contracts, the socket frames,
//     the wire error shape, the hub protocol's HTTP bodies and envelopes,
//     the hex id, account's device list and hub's invokePeer, and the
//     shared leave-out preset): every row of RECORDED_WAVE3 decodes, or
//     is refused, exactly as zod did. That includes each strict payload
//     refusing an undeclared key by name (at any depth it rides), the
//     ref, landing-ref and refspec allowlists with their messages, the
//     chunk charset and bound, the candidate URL-matches-kind refine, a
//     `res` frame whose `error` is malformed still parsing with `error`
//     undefined, an old peer's `res` with `code` alone, every envelope
//     arm (a nack included), the preset reading a bad path as left out,
//     and each void slot taking undefined alone;
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
//   - the web stub walker (now over SchemaAST) gives every contract read
//     the answer the zod walker gave, structural and fabricated.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test schema-port.
import assert from "node:assert/strict";
import { Effect, Schema, Struct } from "effect";
import { decodeWith, safeDecodeWith, validateWith } from "@shared/ipc/codec";
import { allContractModules } from "@shared/ipc/client";
import {
  AccountStatusSchema,
  accountContract,
} from "@shared/ipc/modules/account";
import { branchesContract } from "@shared/ipc/modules/branches";
import { ShellHookStateSchema, cliContract } from "@shared/ipc/modules/cli";
import { clientConfigContract } from "@shared/ipc/modules/clientConfig";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { HubStatusSchema, hubContract } from "@shared/ipc/modules/hub";
import { navContract } from "@shared/ipc/modules/nav";
import { projectLauncherContract } from "@shared/ipc/modules/projectLauncher";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { sharedSettingsContract } from "@shared/ipc/modules/sharedSettings";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { updaterContract } from "@shared/ipc/modules/updater";
import { windowContract } from "@shared/ipc/modules/window";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { projectsContract } from "@shared/ipc/modules/projects";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { terrierContract } from "@shared/ipc/modules/terrier";
import * as schemas from "@shared/schemas";
import * as protocol from "@shared/hub/protocol";
import { HexId32Schema } from "@shared/ipc/hexId";
import { controlContract } from "@shared/ipc/modules/control";
import * as directModule from "@shared/ipc/modules/direct";
import { forwardContract } from "@shared/ipc/modules/forward";
import * as mirrorModule from "@shared/ipc/modules/mirror";
import { portForwardContract } from "@shared/ipc/modules/portForward";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import * as syncModule from "@shared/ipc/modules/sync";
import * as frames from "@shared/ipc/socket/frames";
import { WireErrorShapeSchema } from "@shared/ipc/wireError";
import { parseLeaveOutPreset } from "@shared/sharedSettings";
import {
  DirectoryListingSchema,
  PickFolderPayloadSchema,
  PortNumberSchema,
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
  assert.ok(Schema.isSchema(codec), "the schema is not a Schema");
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

// Wave 2's fixtures and recorded table, in the same form. A row's
// label is an export's name, or "module.call.slot" for a contract slot
// built inline.
const launcher = { id: "l", label: "L", command: "c" };
const carry = { path: "node_modules", mode: "symlink" };
const carryCandidate = {
  name: "n",
  isDirectory: true,
  ignored: true,
  inPrimary: false,
  worktrees: ["w"],
};
const carryStat = { isDirectory: false, inPrimary: true, worktrees: [] };
const fullProjectConfig = {
  scripts: { setup: "pnpm i", teardown: "x" },
  launchers: [launcher],
  portBase: 3000,
  defaultBranch: "main",
  carryOver: [carry, { path: ".env", mode: "copy" }],
  useWorktreeInclude: false,
  worktreeLayout: "in-project",
  customWorktreePath: "/w",
  lastMergeMethod: "squash",
  showPrimaryInInbox: true,
};
const socketHost = { enabled: true, port: 8080, lan: false, token: "t" };
const fullGlobal = {
  launchers: [launcher],
  hiddenLaunchers: ["app:cursor"],
  launchScripts: false,
  deleteBranchOnRemove: true,
  autoPopulateInstall: true,
  autoPullNew: false,
  autoPullPrimaryOnly: true,
  portPool: true,
  terrier: false,
  githubCli: true,
  directConnections: false,
  cloudflaredPath: "/bin/cloudflared",
  socketHost,
};
// Every key the Settings form manages, so every key the remote patch
// takes.
const patchKeys = {
  launchers: [launcher],
  hiddenLaunchers: ["web:github"],
  launchScripts: true,
  deleteBranchOnRemove: false,
  autoPopulateInstall: false,
  autoPullNew: true,
  autoPullPrimaryOnly: false,
  portPool: false,
  terrier: true,
  githubCli: false,
};
const fullClient = {
  theme: "dark",
  doubutsu: false,
  pauseAnimationsOnBattery: true,
  keepReachable: false,
  forwardLocalPorts: { "d:3000": 3001 },
  quickCreateDevices: { "github.com/a/b": "d" },
  sidebarView: "inbox",
  collapsedRemoteProjects: ["g"],
};
const runtimeInfo = {
  dataDir: "/d",
  dataDirSource: "default",
  atDefaultDataDir: true,
  canonicalDataDirName: ".sm",
  homedir: "/h",
};
const entry = { value: "v", at: 3, by: "k" };
const cliStatus = {
  name: "sm",
  aliasName: "shigomori",
  binDir: "/b",
  linkPath: "/b/sm",
  state: "installed",
  foreignPaths: [],
  onPath: true,
};
const hook = { shell: "zsh", path: "/h/.zshrc", state: "installed" };
const hubBase = { onlineDeviceIds: [], peerAppVersions: {} };
const accountStatus = {
  configured: true,
  signedIn: true,
  accountId: "a",
  deviceName: "Mac",
  sharedSignIn: false,
};
const ports = (count) =>
  Array.from({ length: count }, (_, at) => ({ port: 3000 + at }));

const RECORDED_WAVE2 = {
  LauncherCommandSchema: [
    [launcher, same],
    [{ ...launcher, extra: 1 }, ok(launcher)],
    [{ id: "", label: "L", command: "c" }, refuse()],
    [{ id: "l", label: "L", command: "" }, refuse()],
    [{ id: "l", label: "L" }, refuse()],
    [{ id: "l", label: "L", command: 1 }, refuse()],
    [null, refuse()],
  ],
  CarryOverEntrySchema: [
    [carry, same],
    [
      { path: ".env", mode: "copy", extra: 1 },
      ok({ path: ".env", mode: "copy" }),
    ],
    [
      { path: "../x", mode: "copy" },
      refuse("Path must stay within the project root"),
    ],
    [
      { path: "a/../../b", mode: "copy" },
      refuse("Path must stay within the project root"),
    ],
    [
      { path: "/abs", mode: "copy" },
      refuse("Path must stay within the project root"),
    ],
    [
      { path: "a\u0000b", mode: "copy" },
      refuse("Path must stay within the project root"),
    ],
    [{ path: "", mode: "copy" }, refuse()],
    [{ path: "a", mode: "hardlink" }, refuse()],
    [{ path: "a" }, refuse()],
  ],
  ShigomoriConfigSchema: [
    [{ defaultBranch: "main" }, same],
    [fullProjectConfig, same],
    [
      { ...fullProjectConfig, extra: 1, schemaVersion: 1 },
      ok(fullProjectConfig),
    ],
    [
      { defaultBranch: "main", scripts: { setup: "x", junk: 1 } },
      ok({ scripts: { setup: "x" }, defaultBranch: "main" }),
    ],
    [{ defaultBranch: "main", scripts: {} }, same],
    [{ defaultBranch: "main", scripts: { setup: undefined } }, same],
    [{ defaultBranch: "main", scripts: null }, refuse()],
    [
      { defaultBranch: "main", launchers: undefined, portBase: undefined },
      same,
    ],
    [{ defaultBranch: "" }, refuse()],
    [{}, refuse()],
    [{ defaultBranch: "main", portBase: 0 }, refuse()],
    [{ defaultBranch: "main", portBase: 1.5 }, refuse()],
    [{ defaultBranch: "main", portBase: -1 }, refuse()],
    [{ defaultBranch: "main", portBase: Infinity }, refuse()],
    [{ defaultBranch: "main", worktreeLayout: "nested" }, refuse()],
    [{ defaultBranch: "main", lastMergeMethod: "fast-forward" }, refuse()],
    [{ defaultBranch: "main", lastMergeMethod: "rebase" }, same],
    [
      { defaultBranch: "main", carryOver: [{ path: "../x", mode: "copy" }] },
      refuse("Path must stay within the project root"),
    ],
    [{ defaultBranch: "main", launchers: [{ id: "l" }] }, refuse()],
    [{ defaultBranch: "main", useWorktreeInclude: "yes" }, refuse()],
    [{ defaultBranch: "main", customWorktreePath: 1 }, refuse()],
    [null, refuse()],
  ],
  StoredShigomoriConfigSchema: [
    [{ defaultBranch: "main" }, same],
    [{ ...fullProjectConfig, extra: 1, schemaVersion: 1 }, same],
    [{ defaultBranch: "main", future: { deep: [1] } }, same],
    [
      { defaultBranch: "main", scripts: { setup: "x", junk: 1 } },
      ok({ scripts: { setup: "x" }, defaultBranch: "main" }),
    ],
    [{ defaultBranch: "main", portBase: 0 }, refuse()],
    [{ defaultBranch: "main", future: 1, worktreeLayout: "nested" }, refuse()],
    [{}, refuse()],
    [[], refuse()],
  ],
  WorktreeIncludeStatusSchema: [
    [{ fileExists: true, matchedPaths: ["a/", "b"] }, same],
    [
      { fileExists: false, matchedPaths: [], extra: 1 },
      ok({ fileExists: false, matchedPaths: [] }),
    ],
    [{ fileExists: false }, refuse()],
    [{ fileExists: false, matchedPaths: [1] }, refuse()],
  ],
  CarryOverListingPayloadSchema: [
    [{ ...P, relative: "" }, same],
    [{ ...P, relative: "src/a" }, same],
    [
      { ...P, relative: "src", ruleIgnored: true, extra: 1 },
      ok({ ...P, relative: "src", ruleIgnored: true }),
    ],
    [
      { ...P, relative: "../x" },
      refuse("Path must stay within the project root"),
    ],
    [
      { ...P, relative: "/abs" },
      refuse("Path must stay within the project root"),
    ],
    [{ ...P, relative: "", ruleIgnored: "yes" }, refuse()],
    [{ projectId: "", relative: "" }, refuse()],
    [{ ...P }, refuse()],
  ],
  CarryOverCandidateSchema: [
    [carryCandidate, same],
    [{ ...carryCandidate, extra: 1 }, ok(carryCandidate)],
    [
      {
        name: "n",
        isDirectory: true,
        ignored: true,
        inPrimary: false,
        worktrees: undefined,
      },
      refuse(),
    ],
    [
      {
        name: 1,
        isDirectory: true,
        ignored: true,
        inPrimary: false,
        worktrees: ["w"],
      },
      refuse(),
    ],
  ],
  CarryOverStatsPayloadSchema: [
    [{ ...P, paths: [] }, same],
    [
      { ...P, paths: ["a", "b/c"], extra: 1 },
      ok({ ...P, paths: ["a", "b/c"] }),
    ],
    [
      { ...P, paths: ["../x"] },
      refuse("Path must stay within the project root"),
    ],
    [{ ...P, paths: [""] }, refuse()],
    [{ ...P, paths: "a" }, refuse()],
    [{ paths: [] }, refuse()],
  ],
  CarryOverStatSchema: [
    [carryStat, same],
    [{ ...carryStat, extra: 1 }, ok(carryStat)],
    [{ isDirectory: true }, refuse()],
  ],
  ShigomoriWorktreeDataSchema: [
    [{}, same],
    [{ notes: "n" }, same],
    [{ notes: undefined, ports: undefined }, same],
    [
      { ports: [{ port: 3000, label: " web " }] },
      ok({ ports: [{ port: 3000, label: "web" }] }),
    ],
    [
      { ports: [{ port: 3000, extra: 1 }], extra: 1, schemaVersion: 1 },
      ok({ ports: [{ port: 3000 }] }),
    ],
    [{ ports: ports(16) }, same],
    [{ ports: ports(17) }, refuse()],
    [{ ports: [{ port: 0 }] }, refuse()],
    [{ ports: [{ port: 3000, label: "   " }] }, refuse()],
    [{ ports: [{ port: 3000, label: "x".repeat(33) }] }, refuse()],
    [{ ports: [{ port: 3000, label: "x".repeat(32) }] }, same],
    [{ notes: 1 }, refuse()],
    [null, refuse()],
  ],
  GlobalConfigSchema: [
    [{}, same],
    [fullGlobal, same],
    [
      { theme: "dark", doubutsu: true, remoteDevices: [{ token: "x" }] },
      ok({}),
    ],
    [
      { socketHost: { ...socketHost, junk: 1 } },
      ok({ socketHost: socketHost }),
    ],
    [{ socketHost: {} }, same],
    [{ socketHost: { port: 0 } }, refuse()],
    [{ socketHost: { port: 65536 } }, refuse()],
    [{ socketHost: { port: 1.5 } }, refuse()],
    [{ socketHost: { port: 65535, token: "" } }, same],
    [{ socketHost: null }, refuse()],
    [{ launchers: [{ id: "", label: "L", command: "c" }] }, refuse()],
    [{ hiddenLaunchers: [1] }, refuse()],
    [{ launchScripts: "no" }, refuse()],
    [{ cloudflaredPath: 1 }, refuse()],
    [{ directConnections: undefined, launchers: undefined }, same],
    [null, refuse()],
    [[], refuse()],
  ],
  StoredGlobalConfigSchema: [
    [{}, same],
    [fullGlobal, same],
    [
      { theme: "dark", remoteDevices: [{ token: "x" }], schemaVersion: 1 },
      same,
    ],
    [
      { socketHost: { ...socketHost, junk: 1 }, extra: 1 },
      ok({ socketHost: socketHost, extra: 1 }),
    ],
    [{ socketHost: { port: 0 }, extra: 1 }, refuse()],
    [{ extra: undefined }, same],
    [null, refuse()],
  ],
  ReadGlobalConfigSchema: [
    [{}, same],
    [
      {
        launchers: [launcher],
        hiddenLaunchers: ["app:cursor"],
        launchScripts: false,
        deleteBranchOnRemove: true,
        autoPopulateInstall: true,
        autoPullNew: false,
        autoPullPrimaryOnly: true,
        portPool: true,
        terrier: false,
        githubCli: true,
        directConnections: false,
        cloudflaredPath: "/bin/cloudflared",
        socketHost: { enabled: true, port: 1, tokenSet: true },
      },
      same,
    ],
    [
      { socketHost: { ...socketHost, tokenSet: true } },
      ok({
        socketHost: { enabled: true, port: 8080, lan: false, tokenSet: true },
      }),
    ],
    [{ socketHost: { tokenSet: "yes" } }, refuse()],
    [{ theme: "dark", extra: 1 }, same],
    [{ socketHost: { port: 0 } }, refuse()],
  ],
  WriteGlobalConfigPayloadSchema: [
    [{ config: {} }, same],
    [{ config: fullGlobal }, same],
    [
      { config: { theme: "x", launchScripts: true, remoteDevices: [] } },
      ok({ config: { launchScripts: true } }),
    ],
    [{ config: {}, extra: 1 }, ok({ config: {} })],
    [{}, refuse()],
    [{ config: null }, refuse()],
    [{ config: { socketHost: { port: 0 } } }, refuse()],
  ],
  DeviceSettingsPatchSchema: [
    [{}, same],
    [patchKeys, same],
    [{ launchScripts: true }, same],
    [{ launchers: undefined }, same],
    [{ socketHost: {} }, refuse()],
    [{ socketHost: { token: "t" }, launchScripts: true }, refuse()],
    [{ remoteDevices: [] }, refuse()],
    [{ theme: "dark" }, refuse()],
    [{ directConnections: true }, refuse()],
    [{ cloudflaredPath: "/x" }, refuse()],
    [{ extra: undefined }, refuse()],
    [{ launchers: [{ id: "" }] }, refuse()],
    [{ hiddenLaunchers: "x" }, refuse()],
    [null, refuse()],
    [[], refuse()],
  ],
  WriteDeviceSettingsPayloadSchema: [
    [{ patch: {} }, same],
    [
      { patch: { portPool: true }, extra: 1 },
      ok({ patch: { portPool: true } }),
    ],
    [{ patch: { socketHost: { token: "t" } } }, refuse()],
    [{ patch: null }, refuse()],
    [{}, refuse()],
  ],
  ClientConfigSchema: [
    [{}, same],
    [fullClient, same],
    [{ ...fullClient, extra: 1, schemaVersion: 1 }, ok(fullClient)],
    [{ theme: "sepia" }, refuse()],
    [{ forwardLocalPorts: { "d:3000": 0 } }, refuse()],
    [{ forwardLocalPorts: { "d:3000": "3001" } }, refuse()],
    [{ forwardLocalPorts: { "d:3000": 1.5 } }, refuse()],
    [{ forwardLocalPorts: [] }, refuse()],
    [{ quickCreateDevices: { a: 1 } }, refuse()],
    [{ sidebarView: "tree" }, refuse()],
    [{ collapsedRemoteProjects: "g" }, refuse()],
    [{ keepReachable: undefined, theme: undefined }, same],
    [null, refuse()],
  ],
  StoredClientConfigSchema: [
    [{}, same],
    [{ ...fullClient, extra: 1, schemaVersion: 1 }, same],
    [{ theme: "sepia", extra: 1 }, refuse()],
    [{ future: null }, same],
  ],
  WriteClientConfigPayloadSchema: [
    [{ config: {} }, same],
    [{ config: { ...fullClient, extra: 1 } }, ok({ config: fullClient })],
    [{ config: { theme: "x" } }, refuse()],
    [{}, refuse()],
  ],
  WriteShigomoriPayloadSchema: [
    [{ ...P, config: { defaultBranch: "main" } }, same],
    [
      { ...P, config: { defaultBranch: "main", extra: 1 }, extra: 1 },
      ok({ ...P, config: { defaultBranch: "main" } }),
    ],
    [{ ...P, config: {} }, refuse()],
    [{ projectId: "", config: { defaultBranch: "main" } }, refuse()],
    [{ ...P }, refuse()],
  ],
  WorktreeIdSchema: [
    ["0123456789ab", same],
    ["0123456789AB", refuse()],
    ["0123456789a", refuse()],
    ["0123456789abc", refuse()],
    ["01234567890g", refuse()],
    ["", refuse()],
    [12, refuse()],
  ],
  ReadWorktreeDataPayloadSchema: [
    [{ ...P, worktreeId: "0123456789ab" }, same],
    [
      { ...P, worktreeId: "0123456789ab", extra: 1 },
      ok({ ...P, worktreeId: "0123456789ab" }),
    ],
    [{ ...P, worktreeId: "../x" }, refuse()],
    [{ worktreeId: "0123456789ab" }, refuse()],
  ],
  WriteWorktreeDataPayloadSchema: [
    [{ ...P, worktreeId: "0123456789ab", data: {} }, same],
    [
      { ...P, worktreeId: "0123456789ab", data: { notes: "n", junk: 1 } },
      ok({ ...P, worktreeId: "0123456789ab", data: { notes: "n" } }),
    ],
    [
      { ...P, worktreeId: "0123456789ab", data: { ports: [{ port: 0 }] } },
      refuse(),
    ],
    [{ ...P, worktreeId: "0123456789ab" }, refuse()],
  ],
  PreviewThemePayloadSchema: [
    [{ theme: "dark" }, same],
    [{ theme: "light", extra: 1 }, ok({ theme: "light" })],
    [{ theme: "system" }, same],
    [{ theme: "x" }, refuse()],
    [{}, refuse()],
  ],
  RuntimeInfoSchema: [
    [runtimeInfo, same],
    [
      {
        dataDir: "/d",
        dataDirSource: "legacy",
        atDefaultDataDir: true,
        canonicalDataDirName: ".sm",
        homedir: "/h",
        extra: 1,
      },
      ok({
        dataDir: "/d",
        dataDirSource: "legacy",
        atDefaultDataDir: true,
        canonicalDataDirName: ".sm",
        homedir: "/h",
      }),
    ],
    [
      {
        dataDir: "/d",
        dataDirSource: "bad",
        atDefaultDataDir: true,
        canonicalDataDirName: ".sm",
        homedir: "/h",
      },
      refuse(),
    ],
    [
      {
        dataDir: "",
        dataDirSource: "default",
        atDefaultDataDir: true,
        canonicalDataDirName: ".sm",
        homedir: "/h",
      },
      refuse(),
    ],
    [
      {
        dataDir: "/d",
        dataDirSource: "default",
        atDefaultDataDir: true,
        canonicalDataDirName: ".sm",
        homedir: undefined,
      },
      refuse(),
    ],
  ],
  MoveDataDirPayloadSchema: [
    [{}, same],
    [{ parentDir: "/x" }, same],
    [{ parentDir: undefined }, same],
    [{ parentDir: "" }, refuse()],
    [{ parentDir: "/x", extra: 1 }, ok({ parentDir: "/x" })],
    [undefined, refuse()],
    [null, refuse()],
  ],
  NukeProgressSchema: [
    [{ phase: "scripts" }, same],
    [{ phase: "worktrees", done: 1, total: 2 }, same],
    [{ phase: "wipe", extra: 1 }, ok({ phase: "wipe" })],
    [{ phase: "scripts", done: 1 }, ok({ phase: "scripts" })],
    [{ phase: "worktrees", done: -1, total: 2 }, refuse()],
    [{ phase: "worktrees", done: 1.5, total: 2 }, refuse()],
    [{ phase: "worktrees" }, refuse()],
    [{ phase: "other" }, refuse()],
    [{}, refuse()],
  ],
  UpdaterStateSchema: [
    [{ kind: "unsupported" }, same],
    [{ kind: "idle" }, same],
    [{ kind: "checking" }, same],
    [{ kind: "downloading", extra: 1 }, ok({ kind: "downloading" })],
    [{ kind: "ready", version: "1.2.3", releaseDate: null }, same],
    [
      { kind: "ready", version: "1.2.3", notes: "n", releaseDate: "2026" },
      same,
    ],
    [
      { kind: "ready", version: "1.2.3", notes: undefined, releaseDate: null },
      same,
    ],
    [{ kind: "ready", version: "1.2.3" }, refuse()],
    [{ kind: "ready", version: 1, releaseDate: null }, refuse()],
    [{ kind: "error", message: "m" }, same],
    [{ kind: "error" }, refuse()],
    [{ kind: "bogus" }, refuse()],
    [null, refuse()],
  ],
  UpdateRequestSchema: [
    [{ action: "install", requestedAt: 1 }, same],
    [
      { action: "install", requestedAt: 1.5, extra: 1 },
      ok({ action: "install", requestedAt: 1.5 }),
    ],
    [{ action: "check", requestedAt: 1 }, refuse()],
    [{ action: "install", requestedAt: Number.NaN }, refuse()],
    [{ action: "install", requestedAt: Infinity }, refuse()],
    [{ action: "install" }, refuse()],
  ],
  StagedManifestSchema: [
    [{ version: "1", bundleName: "b.app" }, same],
    [{ version: "1", bundleName: "b.app", notes: "n", releaseDate: "d" }, same],
    [
      { version: "1", bundleName: "b.app", extra: 1 },
      ok({ version: "1", bundleName: "b.app" }),
    ],
    [{ version: "", bundleName: "b.app" }, refuse()],
    [{ version: "1", bundleName: "" }, refuse()],
    [{ version: "1", bundleName: "b.app", notes: null }, refuse()],
  ],
  UpdateStageEventSchema: [
    [{ event: "downloading" }, same],
    [{ event: "verifying", ok: true }, ok({ event: "verifying" })],
    [{ event: "staged" }, refuse()],
    [{}, refuse()],
  ],
  UpdateStageResultSchema: [
    [{ status: "up-to-date", version: "1" }, same],
    [
      { status: "up-to-date", version: "1", ok: true },
      ok({ status: "up-to-date", version: "1" }),
    ],
    [{ status: "staged", version: "2", installed: "1" }, same],
    [
      {
        status: "staged",
        version: "2",
        installed: "1",
        notes: "n",
        releaseDate: "d",
        ok: true,
      },
      ok({
        status: "staged",
        version: "2",
        installed: "1",
        notes: "n",
        releaseDate: "d",
      }),
    ],
    [{ status: "staged", version: "", installed: "1" }, refuse()],
    [{ status: "staged", version: "2" }, refuse()],
    [{ status: "failed", version: "2" }, refuse()],
  ],
  SharedSettingValueSchema: [
    ["x", same],
    ["", same],
    ["x".repeat(256), same],
    ["x".repeat(257), refuse()],
    [1.5, same],
    [-3, same],
    [Number.NaN, refuse()],
    [Infinity, refuse()],
    [true, same],
    [null, same],
    [undefined, refuse()],
    [{}, refuse()],
    [[], refuse()],
  ],
  SharedSettingEntrySchema: [
    [entry, same],
    [{ ...entry, extra: 1 }, ok(entry)],
    [{ value: null, at: 3, by: "k" }, same],
    [{ value: "v", at: 0, by: "k" }, same],
    [{ value: "v", at: 8640000000000000, by: "k" }, same],
    [{ value: "v", at: 8640000000000001, by: "k" }, refuse()],
    [{ value: "v", at: -1, by: "k" }, refuse()],
    [{ value: "v", at: 1.5, by: "k" }, refuse()],
    [{ value: "v", at: 3, by: "" }, refuse()],
    [{ value: "v", at: 3, by: "b".repeat(128) }, same],
    [{ value: "v", at: 3, by: "b".repeat(129) }, refuse()],
    [{ at: 3, by: "k" }, refuse()],
    [{ value: undefined, at: 3, by: "k" }, refuse()],
  ],
  SharedSettingsDocSchema: [
    [{ entries: {} }, same],
    [{ entries: { k: entry }, extra: 1 }, ok({ entries: { k: entry } })],
    [
      {
        entries: {
          good: entry,
          tooLong: { value: "x".repeat(300), at: 4, by: "k" },
          badStamp: { value: true, at: 9007199254740991, by: "k" },
          notAnEntry: 5,
          withExtra: { ...entry, junk: 1 },
          "": entry,
          kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk:
            entry,
          kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk:
            entry,
        },
      },
      ok({
        entries: {
          good: entry,
          withExtra: entry,
          kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk:
            entry,
        },
      }),
    ],
    [{ entries: { 1: entry, 2: entry, b: entry, a: entry } }, same],
    [
      {
        entries: {
          ["__proto__"]: { value: 1, at: 1, by: "k" },
          k: { value: 1, at: 1, by: "k" },
        },
      },
      ok({ entries: { k: { value: 1, at: 1, by: "k" } } }),
    ],
    [{ entries: [] }, refuse()],
    [{ entries: [entry] }, refuse()],
    [{ entries: null }, refuse()],
    [{ entries: "x" }, refuse()],
    [{}, refuse()],
    [null, refuse()],
  ],
  SetSharedSettingPayloadSchema: [
    [{ key: "k", value: null }, same],
    [{ key: "k", value: "v", extra: 1 }, ok({ key: "k", value: "v" })],
    [{ key: "", value: 1 }, refuse()],
    [{ key: "k".repeat(512), value: 1 }, same],
    [{ key: "k".repeat(513), value: 1 }, refuse()],
    [{ key: "k" }, refuse()],
    [{ key: "k", value: {} }, refuse()],
  ],
  MergeSharedSettingsPayloadSchema: [
    [
      { doc: { entries: { k: entry, bad: 5 } } },
      ok({ doc: { entries: { k: entry } } }),
    ],
    [{ doc: { entries: {} }, extra: 1 }, ok({ doc: { entries: {} } })],
    [{ doc: {} }, refuse()],
    [{}, refuse()],
  ],
  "cli.status.output": [
    [cliStatus, same],
    [
      {
        name: "sm",
        aliasName: "shigomori",
        binDir: "/b",
        linkPath: "/b/sm",
        state: "foreign",
        foreignPaths: ["/b/x"],
        onPath: true,
        extra: 1,
      },
      ok({
        name: "sm",
        aliasName: "shigomori",
        binDir: "/b",
        linkPath: "/b/sm",
        state: "foreign",
        foreignPaths: ["/b/x"],
        onPath: true,
      }),
    ],
    [
      {
        name: "sm",
        aliasName: "shigomori",
        binDir: "/b",
        linkPath: "/b/sm",
        state: "gone",
        foreignPaths: [],
        onPath: true,
      },
      refuse(),
    ],
    [
      {
        name: "sm",
        aliasName: "shigomori",
        binDir: "/b",
        linkPath: "/b/sm",
        state: "installed",
        foreignPaths: undefined,
        onPath: true,
      },
      refuse(),
    ],
  ],
  "cli.install.input": [
    [{ force: true }, same],
    [{ force: false, extra: 1 }, ok({ force: false })],
    [{}, refuse()],
    [{ force: "yes" }, refuse()],
    [undefined, refuse()],
  ],
  "cli.shellStatus.output": [
    [{ loginShell: null, shells: [] }, same],
    [
      { loginShell: "zsh", shells: [hook, { ...hook, extra: 1 }], extra: 1 },
      ok({ loginShell: "zsh", shells: [hook, hook] }),
    ],
    [{ shells: [] }, refuse()],
    [
      {
        loginShell: null,
        shells: [{ shell: "zsh", path: "/h/.zshrc", state: "foreign" }],
      },
      refuse(),
    ],
  ],
  ShellHookStateSchema: [
    [hook, same],
    [
      { shell: "zsh", path: "/h/.zshrc", state: "modified", extra: 1 },
      ok({ shell: "zsh", path: "/h/.zshrc", state: "modified" }),
    ],
    [{ shell: "zsh", path: "/h/.zshrc", state: "missing" }, same],
    [{ shell: "zsh", path: "/h/.zshrc", state: "stale" }, refuse()],
    [{ shell: "zsh" }, refuse()],
  ],
  HubStatusSchema: [
    [{ ...hubBase, socket: { phase: "idle" } }, same],
    [
      {
        socket: { phase: "connecting", extra: 1 },
        onlineDeviceIds: ["a"],
        peerAppVersions: { a: "1.0" },
        tunnel: "up",
        extra: 1,
      },
      ok({
        socket: { phase: "connecting" },
        onlineDeviceIds: ["a"],
        peerAppVersions: { a: "1.0" },
        tunnel: "up",
      }),
    ],
    [
      {
        ...hubBase,
        socket: {
          phase: "connected",
          remoteDeviceId: "",
          remoteAppVersion: "",
        },
      },
      same,
    ],
    [{ ...hubBase, socket: { phase: "connected" } }, refuse()],
    [
      { ...hubBase, socket: { phase: "backoff", attempt: 2, delayMs: 1.5 } },
      same,
    ],
    [
      { ...hubBase, socket: { phase: "backoff", attempt: 1.5, delayMs: 1 } },
      refuse(),
    ],
    [
      {
        ...hubBase,
        socket: { phase: "backoff", attempt: 1, delayMs: Number.NaN },
      },
      refuse(),
    ],
    [
      {
        ...hubBase,
        socket: { phase: "blocked", reason: "revoked", message: "m" },
      },
      same,
    ],
    [
      {
        ...hubBase,
        socket: { phase: "blocked", reason: "banned", message: "m" },
      },
      refuse(),
    ],
    [{ ...hubBase, socket: { phase: "stopped" }, tunnel: "no-binary" }, same],
    [{ ...hubBase, socket: { phase: "stopped" }, tunnel: "down" }, refuse()],
    [{ ...hubBase, socket: { phase: "stopped" }, tunnel: undefined }, same],
    [
      {
        socket: { phase: "stopped" },
        onlineDeviceIds: [],
        peerAppVersions: { a: 1 },
      },
      refuse(),
    ],
    [{ ...hubBase, socket: { phase: "gone" } }, refuse()],
    [hubBase, refuse()],
  ],
  "hub.peerPush.payload": [
    [{ deviceId: "d", channel: "c" }, same],
    [
      { deviceId: "d", channel: "c", payload: { x: [1] }, extra: 1 },
      ok({ deviceId: "d", channel: "c", payload: { x: [1] } }),
    ],
    [{ deviceId: "d", channel: "c", payload: undefined }, same],
    [{ deviceId: "d", channel: "c", payload: null }, same],
    [{ deviceId: "d" }, refuse()],
    [{ deviceId: 1, channel: "c" }, refuse()],
  ],
  "account.status.output": [
    [accountStatus, same],
    [{ ...accountStatus, credential: "secret" }, ok(accountStatus)],
    [
      {
        configured: true,
        signedIn: true,
        accountId: "a",
        deviceName: "Mac",
        sharedSignIn: undefined,
      },
      refuse(),
    ],
  ],
  "account.enroll.input": [
    ["t", same],
    ["", refuse()],
    [1, refuse()],
    [undefined, refuse()],
  ],
  "account.setDeviceName.input": [
    ["n", same],
    ["", refuse()],
    ["n".repeat(256), same],
    ["n".repeat(257), refuse()],
    [1, refuse()],
  ],
  "account.acceptsCommands.output": [
    [true, same],
    [false, same],
    ["true", refuse()],
    [undefined, refuse()],
  ],
  "account.setAcceptsCommands.input": [
    [false, same],
    [true, same],
    [undefined, refuse()],
    [0, refuse()],
  ],
  "account.changed.payload": [
    [{ accountId: null }, same],
    [{ accountId: "a", extra: 1 }, ok({ accountId: "a" })],
    [{}, refuse()],
    [{ accountId: 1 }, refuse()],
    [{ accountId: undefined }, refuse()],
  ],
  "nav.launchById.payload": [
    ["x", same],
    ["", same],
    [1, refuse()],
    [undefined, refuse()],
  ],
  "shigomori.read.output": [
    [null, same],
    [{ defaultBranch: "main", extra: 1 }, same],
    [{ defaultBranch: "" }, refuse()],
    [undefined, refuse()],
  ],
  "shigomori.worktreeDataRead.output": [
    [null, same],
    [{ notes: "n", junk: 1 }, ok({ notes: "n" })],
    [{ notes: 1 }, refuse()],
    [undefined, refuse()],
  ],
  "projects.carryOverListing.output": [
    [[], same],
    [[{ ...carryCandidate, extra: 1 }], ok([carryCandidate])],
    [[{ name: "n" }], refuse()],
    [{}, refuse()],
  ],
  "projects.carryOverStats.output": [
    [{}, same],
    [
      { a: carryStat, "b/c": { ...carryStat, extra: 1 } },
      ok({ a: carryStat, "b/c": carryStat }),
    ],
    [{ a: {} }, refuse()],
    [[], refuse()],
    [null, refuse()],
  ],
};

const VOID_SLOTS = [
  "globalConfig.read.input",
  "globalConfig.readLocal.input",
  "globalConfig.write.output",
  "globalConfig.writeDeviceSettings.output",
  "runtime.info.input",
  "runtime.nuke.input",
  "runtime.nuke.output",
  "runtime.moveDataDir.output",
  "sharedSettings.read.input",
  "updater.get.input",
  "updater.check.input",
  "updater.check.output",
  "updater.install.input",
  "updater.install.output",
  "clientConfig.read.input",
  "clientConfig.write.output",
  "projectLauncher.toggle.payload",
  "projectLauncher.addProject.payload",
  "cli.status.input",
  "cli.uninstall.input",
  "cli.shellStatus.input",
  "cli.shellInstall.input",
  "cli.shellUninstall.input",
  "nav.openSettings.payload",
  "window.focused.payload",
  "window.blurred.payload",
  "window.previewTheme.output",
  "window.relaunch.input",
  "window.relaunch.output",
  "shigomori.write.output",
  "shigomori.worktreeDataWrite.output",
  "account.status.input",
  "account.signOut.input",
  "account.signOut.output",
  "account.revokeDevice.output",
  "account.listDevices.input",
  "account.setAcceptsCommands.output",
  "account.acceptsCommands.input",
  "account.commandAccessChanged.payload",
  "hub.status.input",
];

// Each void slot answered undefined, and refused everything else.
const VOID_ROWS = [
  [undefined, ok(undefined)],
  [null, refuse()],
  [{}, refuse()],
  [0, refuse()],
  ["", refuse()],
];

const WAVE2_CONTRACTS = {
  account: accountContract,
  cli: cliContract,
  clientConfig: clientConfigContract,
  globalConfig: globalConfigContract,
  hub: hubContract,
  nav: navContract,
  projectLauncher: projectLauncherContract,
  projects: projectsContract,
  runtime: runtimeContract,
  sharedSettings: sharedSettingsContract,
  shigomori: shigomoriContract,
  updater: updaterContract,
  window: windowContract,
};
const MODULE_SCHEMAS = {
  AccountStatusSchema,
  HubStatusSchema,
  ShellHookStateSchema,
};

function wave2Codec(label) {
  if (label in schemas) return schemas[label];
  if (label in MODULE_SCHEMAS) return MODULE_SCHEMAS[label];
  const [module, call, slot] = label.split(".");
  return WAVE2_CONTRACTS[module].calls[call][slot];
}

// Wave 3's fixtures and recorded table (the wire layer), in the same
// form as wave 2's.
const wt3 = "0123456789ab";
const hex = "0123456789abcdef0123456789abcdef";
const c1 = "abc1234";
const tree40 = "a".repeat(40);
const dev = "dev-1";
const mainRef = "refs/heads/main";
const landing = "refs/shigomori/sync/main";
const B64_MAX = 853_336;
const IGNORES_MAX = 512;
const pw = { projectId: "p", worktreeId: wt3 };
const gitCore = {
  head: { kind: "branch", branch: "main" },
  tip: c1,
  indexTree: tree40,
};
const endpoint = {
  connected: true,
  scanned: true,
  directories: 1,
  files: 2,
  symbolicLinks: 0,
  totalFileSize: 10,
  problems: [{ path: "a", error: "e" }],
  excludedProblems: 0,
};
const session = {
  session: "sync_abc",
  name: "n",
  labels: { copySide: "remote" },
  localRoot: "/l",
  localProjectId: "p",
  localWorktreeId: wt3,
  deviceId: dev,
  projectId: "q",
  worktreeId: wt3,
  remoteRoot: "/r",
  paused: false,
  ignores: ["/dist"],
  ignoreMode: "custom",
  createdAt: 1,
  status: "watching",
  statusText: "Watching",
  successfulCycles: 3,
  conflicts: [
    {
      root: "r",
      localChanges: [{ path: "a", kind: "modified" }],
      remoteChanges: [],
    },
  ],
  excludedConflicts: 0,
  local: endpoint,
  remote: {
    ...endpoint,
    staging: {
      path: "s",
      receivedFiles: 1,
      expectedFiles: 2,
      receivedSize: 3,
      expectedSize: 4,
    },
  },
};
const serving = {
  channelId: hex,
  projectId: "p",
  worktreeId: wt3,
  peerDeviceId: "",
  since: 5,
};
const pullBase = {
  sourceDeviceId: dev,
  sourceProjectId: "p",
  sourceWorktreeId: wt3,
  sourceIdentity: "github.com/a/b",
  branch: "main",
};
const sendBase = { targetDeviceId: dev, projectId: "p", worktreeId: wt3 };
const pulled = { worktree, captured: true, dirtyApplied: false };
const controlMirror = {
  session: "s",
  device: { deviceId: "d", name: "n" },
  localProjectId: "p",
  localWorktreeId: wt3,
  localRoot: "/l",
  remoteRoot: "/r",
  copySide: "local",
  paused: false,
  status: "watching",
  statusText: "W",
  conflicts: 0,
};
const deviceInfo = {
  deviceId: dev,
  name: "Mac",
  platform: "darwin",
  createdAt: 1,
  lastSeenAt: null,
  online: true,
};
const lanCandidate = { kind: "lan", url: "ws://192.168.1.2:4000", ticket: "t" };
const tunnelCandidate = {
  kind: "tunnel",
  url: "wss://a.example.com",
  ticket: "t",
};
const resErr = { t: "res", id: 1, ok: false, message: "m" };
const events = (count) =>
  Array.from({ length: count }, () => ({
    at: 1,
    kind: "git-synced",
    detail: "d",
  }));

const RECORDED_WAVE3 = {
  HexId32Schema: [
    [hex, same],
    [hex.toUpperCase(), refuse()],
    [hex.slice(1), refuse()],
    [`${hex}0`, refuse()],
    ["", refuse()],
    [5, refuse()],
  ],
  ChunkB64Schema: [
    ["QUJD", same],
    ["", same],
    ["QQ==", same],
    ["QUI=", same],
    ["a+/b", same],
    ["QQ===", refuse()],
    ["Q=Q=", refuse()],
    ["a b", refuse()],
    ["a\nb", refuse()],
    ["-_", refuse()],
    ["A".repeat(B64_MAX), same],
    ["A".repeat(B64_MAX + 1), refuse()],
    [5, refuse()],
  ],
  SyncLandingRefSchema: [
    [landing, same],
    ["refs/shigomori/dirty/0123456789ab", same],
    ["refs/shigomori/x.lock/", same],
    [mainRef, refuse()],
    ["refs/shigomori/a..b", refuse("Ref outside the app's namespace")],
    ["refs/shigomori/a//b", refuse("Ref outside the app's namespace")],
    ["refs/shigomori/-x", refuse()],
    ["", refuse()],
    [5, refuse()],
  ],
  "sync.refTips.input": [
    [{ projectId: "p", refs: [mainRef] }, same],
    [
      {
        projectId: "p",
        refs: [
          "refs/shigomori/dirty/0123456789ab",
          "refs/shigomori/index/0123456789ab",
          "refs/heads/feat/x.y_z-1",
          "refs/heads/main.lock",
          "refs/heads/a/",
        ],
      },
      same,
    ],
    [{ projectId: "p", refs: Array(64).fill(mainRef) }, same],
    [
      { projectId: "p", refs: [mainRef], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
    [{ projectId: "", refs: [mainRef] }, refuse()],
    [{ projectId: "p", refs: [] }, refuse()],
    [{ projectId: "p", refs: Array(65).fill(mainRef) }, refuse()],
    [
      { projectId: "p", refs: ["refs/tags/v1"] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { projectId: "p", refs: ["refs/heads/a..b"] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { projectId: "p", refs: ["refs/heads//a"] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { projectId: "p", refs: ["refs/heads/-x"] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { projectId: "p", refs: ["refs/shigomori/dirty/0123456789AB"] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { projectId: "p", refs: ["refs/shigomori/sync/x"] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { projectId: "p", refs: [` ${mainRef}`] },
      refuse("Ref outside the sync allowlist"),
    ],
    [null, refuse()],
  ],
  SyncRefTipsResultSchema: [
    [{ tips: [] }, same],
    [{ tips: [{ ref: mainRef, commit: c1 }] }, same],
    [
      { tips: [{ ref: mainRef, commit: c1, x: 1 }] },
      refuse('Unexpected key "x"'),
    ],
    [{ tips: [], x: 1 }, refuse('Unexpected key "x"')],
    [
      { tips: [{ ref: "refs/tags/v1", commit: c1 }] },
      refuse("Ref outside the sync allowlist"),
    ],
    [
      { tips: [{ ref: mainRef, commit: "XYZ" }] },
      refuse("Invalid commit hash"),
    ],
    [{}, refuse()],
  ],
  "sync.captureDirty.input": [
    [pw, same],
    [{ ...pw, extra: 1 }, refuse('Unexpected key "extra"')],
    [{ projectId: "p", worktreeId: "0123456789AB" }, refuse()],
    [{ projectId: "p", worktreeId: "abc" }, refuse()],
    [{ projectId: "", worktreeId: wt3 }, refuse()],
    [{ projectId: "p" }, refuse()],
  ],
  SyncCaptureDirtyResultSchema: [
    [{ captured: true, commit: c1 }, same],
    [{ captured: false }, same],
    [{ captured: false, commit: undefined }, same],
    [{ captured: true, commit: "zz" }, refuse("Invalid commit hash")],
    [{ captured: "yes" }, refuse()],
    [{ captured: true, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "sync.worktreeFolder.input": [
    [{ ...pw, relative: "" }, same],
    [{ ...pw, relative: "src/lib" }, same],
    [{ ...pw, relative: "../x" }, refuse("Path must stay within the worktree")],
    [
      { ...pw, relative: "a/../../x" },
      refuse("Path must stay within the worktree"),
    ],
    [{ ...pw, relative: "/abs" }, refuse("Path must stay within the worktree")],
    [{ ...pw, relative: "a\0b" }, refuse("Path must stay within the worktree")],
    [{ ...pw, relative: "src", extra: 1 }, refuse('Unexpected key "extra"')],
    [pw, refuse()],
  ],
  "sync.worktreeFolder.output": [
    [[], same],
    [[{ name: "a", isDirectory: true, ignored: false }], same],
    [[{ name: "", isDirectory: true, ignored: false }], refuse()],
    [
      [{ name: "a", isDirectory: true, ignored: false, extra: 1 }],
      refuse('Unexpected key "extra"'),
    ],
    [[{ name: "a", isDirectory: true }], refuse()],
    [{}, refuse()],
  ],
  "sync.ignoredPaths.input": [
    [pw, same],
    [{ ...pw, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  SyncIgnoredPathsResultSchema: [
    [{ paths: [], total: 0, patterns: [] }, same],
    [
      {
        paths: Array(32).fill("a/"),
        total: 40,
        patterns: Array(IGNORES_MAX).fill("dist"),
      },
      same,
    ],
    [{ paths: Array(33).fill("a/"), total: 40, patterns: [] }, refuse()],
    [
      { paths: [], total: 0, patterns: Array(IGNORES_MAX + 1).fill("d") },
      refuse(),
    ],
    [{ paths: [], total: -1, patterns: [] }, refuse()],
    [{ paths: [], total: 1.5, patterns: [] }, refuse()],
    [{ paths: [], total: 0 }, refuse()],
    [
      { paths: [], total: 0, patterns: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "sync.bundleStart.input": [
    [{ projectId: "p", refs: [mainRef], haves: [] }, same],
    [{ projectId: "p", refs: [mainRef], haves: Array(256).fill(c1) }, same],
    [{ projectId: "p", refs: [mainRef], haves: Array(257).fill(c1) }, refuse()],
    [
      { projectId: "p", refs: [mainRef], haves: ["XYZ"] },
      refuse("Invalid commit hash"),
    ],
    [{ projectId: "p", refs: [mainRef] }, refuse()],
    [
      { projectId: "p", refs: [mainRef], haves: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  SyncBundleStartResultSchema: [
    [{ transferId: hex, bytes: 0 }, same],
    [{ transferId: hex.toUpperCase(), bytes: 0 }, refuse()],
    [{ transferId: hex.slice(1), bytes: 0 }, refuse()],
    [{ transferId: hex, bytes: -1 }, refuse()],
    [{ transferId: hex, bytes: 0, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "sync.bundleChunk.input": [
    [{ transferId: hex, offset: 0 }, same],
    [{ transferId: hex, offset: 1.5 }, refuse()],
    [{ transferId: hex, offset: -1 }, refuse()],
    [{ transferId: "x", offset: 0 }, refuse()],
    [
      { transferId: hex, offset: 0, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "sync.bundleChunk.output": [
    [{ dataB64: "QUJD", eof: false }, same],
    [{ dataB64: "", eof: true }, same],
    [{ dataB64: "QQ===", eof: false }, refuse()],
    [{ dataB64: "A".repeat(B64_MAX + 1), eof: false }, refuse()],
    [
      { dataB64: "QUJD", eof: false, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "sync.bundleAbort.input": [
    [{ transferId: hex }, same],
    [{ transferId: hex, extra: 1 }, refuse('Unexpected key "extra"')],
    [{}, refuse()],
  ],
  "sync.pushStart.input": [
    [{ projectId: "p", bytes: 0 }, same],
    [{ projectId: "p", bytes: -1 }, refuse()],
    [{ projectId: "p", bytes: 0, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "sync.pushStart.output": [
    [{ transferId: hex }, same],
    [{ transferId: hex, pipelined: true }, same],
    [{ transferId: hex, pipelined: false }, refuse()],
    [{ transferId: hex, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "sync.pushChunk.input": [
    [{ transferId: hex, offset: 0, dataB64: "QUJD" }, same],
    [{ transferId: hex, offset: 0, dataB64: "a b" }, refuse()],
    [
      { transferId: hex, offset: 0, dataB64: "QUJD", extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "sync.pushFinish.input": [
    [{ transferId: hex, refspecs: [`${mainRef}:${landing}`] }, same],
    [
      {
        transferId: hex,
        refspecs: [
          "refs/shigomori/dirty/0123456789ab:refs/shigomori/dirty/0123456789ab",
        ],
      },
      same,
    ],
    [
      { transferId: hex, refspecs: Array(64).fill(`${mainRef}:${landing}`) },
      same,
    ],
    [{ transferId: hex, refspecs: [] }, refuse()],
    [
      { transferId: hex, refspecs: Array(65).fill(`${mainRef}:${landing}`) },
      refuse(),
    ],
    [
      { transferId: hex, refspecs: [mainRef] },
      refuse("Refspec outside the sync allowlist"),
    ],
    [
      { transferId: hex, refspecs: [`:${landing}`] },
      refuse("Refspec outside the sync allowlist"),
    ],
    [
      { transferId: hex, refspecs: [`refs/tags/v1:${landing}`] },
      refuse("Refspec outside the sync allowlist"),
    ],
    [
      { transferId: hex, refspecs: [`${mainRef}:${mainRef}`] },
      refuse("Refspec outside the sync allowlist"),
    ],
    [
      { transferId: hex, refspecs: [`${mainRef}:refs/shigomori/a:b`] },
      refuse("Refspec outside the sync allowlist"),
    ],
    [
      { transferId: hex, refspecs: [`${mainRef}:refs/shigomori/a..b`] },
      refuse("Refspec outside the sync allowlist"),
    ],
    [
      {
        transferId: hex,
        refspecs: [`${mainRef}:refs/shigomori/${"a".repeat(512)}`],
      },
      refuse(),
    ],
    [
      { transferId: hex, refspecs: [`${mainRef}:${landing}`], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "sync.pushFinish.output": [
    [{ fetched: [] }, same],
    [{ fetched: [{ ref: "anything", commit: c1 }] }, same],
    [
      { fetched: [{ ref: "x", commit: c1, extra: 1 }] },
      refuse('Unexpected key "extra"'),
    ],
    [{ fetched: [{ ref: "x", commit: "zz" }] }, refuse("Invalid commit hash")],
    [{ fetched: [], extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "sync.hasCommits.input": [
    [{ projectId: "p", commits: [c1] }, same],
    [{ projectId: "p", commits: Array(64).fill(c1) }, same],
    [{ projectId: "p", commits: [] }, refuse()],
    [{ projectId: "p", commits: Array(65).fill(c1) }, refuse()],
    [{ projectId: "p", commits: ["zz"] }, refuse("Invalid commit hash")],
    [
      { projectId: "p", commits: [c1], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  SyncHasCommitsResultSchema: [
    [{ present: [] }, same],
    [{ present: [c1, "d".repeat(64)] }, same],
    [{ present: ["zz"] }, refuse("Invalid commit hash")],
    [{ present: [], extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "sync.landCheck.input": [
    [{ identity: "github.com/a/b", branch: "main" }, same],
    [
      { identity: "github.com/a/b", branch: "feat/x", worktreeName: "fox" },
      same,
    ],
    [{ identity: "i", branch: "main", worktreeName: undefined }, same],
    [{ identity: "i", branch: "main", worktreeName: "" }, refuse()],
    [
      { identity: "i", branch: "main", worktreeName: ".." },
      refuse("Not a valid folder name"),
    ],
    [
      { identity: "i", branch: "main", worktreeName: "a/b" },
      refuse("Not a valid folder name"),
    ],
    [
      { identity: "i", branch: "-x" },
      refuse("Branch names cannot start with '-'"),
    ],
    [
      { identity: "i", branch: "a..b" },
      refuse("Branch name outside the sync allowlist"),
    ],
    [
      { identity: "i", branch: "a b" },
      refuse("Branch name outside the sync allowlist"),
    ],
    [{ identity: "i", branch: "" }, refuse()],
    [{ identity: "", branch: "main" }, refuse()],
    [
      { identity: "i", branch: "main", extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  SyncLandCheckResultSchema: [
    [{ projectId: "p" }, same],
    [{ projectId: "" }, refuse()],
    [{ projectId: "p", extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  SyncLandWorktreePayloadSchema: [
    [{ identity: "i", branch: "main", branchTip: c1 }, same],
    [
      {
        identity: "i",
        branch: "main",
        worktreeName: "fox",
        branchTip: c1,
        runSetup: true,
        capture: { sourceWorktreeId: wt3, commit: c1 },
      },
      same,
    ],
    [
      {
        identity: "i",
        branch: "main",
        branchTip: c1,
        capture: { sourceWorktreeId: wt3, commit: c1, x: 1 },
      },
      refuse('Unexpected key "x"'),
    ],
    [
      {
        identity: "i",
        branch: "main",
        branchTip: c1,
        capture: { sourceWorktreeId: "w", commit: c1 },
      },
      refuse(),
    ],
    [
      { identity: "i", branch: "main", branchTip: "zz" },
      refuse("Invalid commit hash"),
    ],
    [{ identity: "i", branch: "main" }, refuse()],
    [
      { identity: "i", branch: "main", branchTip: c1, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  SyncLandWorktreeResultSchema: [
    [
      { worktree, dirtyApplied: false },
      ok({ worktree: { ...worktree, autoPull: false }, dirtyApplied: false }),
    ],
    [{ worktree: { ...worktree, autoPull: true }, dirtyApplied: true }, same],
    [
      { worktree: { ...worktree, junk: 1 }, dirtyApplied: true },
      ok({ worktree: { ...worktree, autoPull: false }, dirtyApplied: true }),
    ],
    [
      { worktree, dirtyApplied: false, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
    [{ worktree: { ...worktree, ahead: -1 }, dirtyApplied: false }, refuse()],
  ],
  MirrorIgnoreModeSchema: [
    ["everything", same],
    ["gitignored", same],
    ["custom", same],
    ["bring", same],
    ["nothing", refuse()],
    [undefined, refuse()],
  ],
  MirrorIgnoresSchema: [
    [[], same],
    [["/dist", "!keep", "*.log"], same],
    [Array(IGNORES_MAX).fill("a"), same],
    [Array(IGNORES_MAX + 1).fill("a"), refuse()],
    [[""], refuse()],
    [["a\nb"], refuse("Ignore pattern must be one line")],
    [["a\rb"], refuse("Ignore pattern must be one line")],
    [["x".repeat(1024)], same],
    [["x".repeat(1025)], refuse()],
    [[5], refuse()],
  ],
  SyncPullWorktreePayloadSchema: [
    [pullBase, same],
    [
      {
        ...pullBase,
        branch: "feat/x",
        worktreeName: "fox",
        runSetup: false,
        ignoreMode: "custom",
        ignores: ["/dist"],
      },
      same,
    ],
    [{ ...pullBase, ignoreMode: undefined, ignores: undefined }, same],
    [{ ...pullBase, ignoreMode: "other" }, refuse()],
    [
      { ...pullBase, ignores: ["a\nb"] },
      refuse("Ignore pattern must be one line"),
    ],
    [{ ...pullBase, ignores: [""] }, refuse()],
    [{ ...pullBase, sourceDeviceId: "" }, refuse()],
    [{ ...pullBase, sourceDeviceId: "x".repeat(200) }, same],
    [{ ...pullBase, sourceDeviceId: "x".repeat(201) }, refuse()],
    [{ ...pullBase, sourceWorktreeId: "w" }, refuse()],
    [{ ...pullBase, sourceIdentity: "" }, refuse()],
    [
      { ...pullBase, branch: "a..b" },
      refuse("Branch name outside the sync allowlist"),
    ],
    [
      { ...pullBase, branch: "-x" },
      refuse("Branch names cannot start with '-'"),
    ],
    [
      { ...pullBase, branch: "a b" },
      refuse("Branch name outside the sync allowlist"),
    ],
    [{ ...pullBase, worktreeName: "a/b" }, refuse("Not a valid folder name")],
    [{ ...pullBase, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  SyncPullStepSchema: [
    ["capture", same],
    ["files", same],
    ["other", refuse()],
    [1, refuse()],
  ],
  "sync.pullProgress.payload": [
    [{ sourceWorktreeId: wt3, step: "capture" }, same],
    [
      { sourceWorktreeId: wt3, step: "transfer", bytes: 10, totalBytes: 20 },
      same,
    ],
    [{ sourceWorktreeId: wt3, step: "create", createPhase: "setup" }, same],
    [{ sourceWorktreeId: wt3, step: "create", createPhase: "idle" }, refuse()],
    [{ sourceWorktreeId: wt3, step: "transfer", bytes: -1 }, refuse()],
    [
      { sourceWorktreeId: wt3, step: "capture", extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  SyncPullWorktreeResultSchema: [
    [
      pulled,
      ok({
        worktree: { ...worktree, autoPull: false },
        captured: true,
        dirtyApplied: false,
      }),
    ],
    [
      { ...pulled, files: { crossed: true, conflicts: 0 } },
      ok({
        worktree: { ...worktree, autoPull: false },
        captured: true,
        dirtyApplied: false,
        files: { crossed: true, conflicts: 0 },
      }),
    ],
    [
      { ...pulled, files: { crossed: false, conflicts: 2, error: "e" } },
      ok({
        worktree: { ...worktree, autoPull: false },
        captured: true,
        dirtyApplied: false,
        files: { crossed: false, conflicts: 2, error: "e" },
      }),
    ],
    [
      { ...pulled, files: { crossed: true, conflicts: 0, x: 1 } },
      refuse('Unexpected key "x"'),
    ],
    [{ ...pulled, files: { crossed: true, conflicts: -1 } }, refuse()],
    [{ ...pulled, extra: 1 }, refuse('Unexpected key "extra"')],
    [{ worktree, captured: true }, refuse()],
  ],
  SyncSendWorktreePayloadSchema: [
    [sendBase, same],
    [
      { ...sendBase, runSetup: true, ignoreMode: "bring", ignores: ["x"] },
      same,
    ],
    [
      { ...sendBase, ignores: ["a\nb"] },
      refuse("Ignore pattern must be one line"),
    ],
    [{ ...sendBase, worktreeId: "w" }, refuse()],
    [{ ...sendBase, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  SyncTeardownSourcePayloadSchema: [
    [
      { sourceDeviceId: dev, sourceProjectId: "p", sourceWorktreeId: wt3 },
      same,
    ],
    [
      { sourceDeviceId: dev, sourceProjectId: "p", sourceWorktreeId: "w" },
      refuse(),
    ],
    [
      {
        sourceDeviceId: dev,
        sourceProjectId: "p",
        sourceWorktreeId: wt3,
        extra: 1,
      },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "sync.teardownSource.output": [
    [{ sourceRemoved: true }, same],
    [{ sourceRemoved: false, sourceError: "scripts-running" }, same],
    [{ sourceRemoved: true, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  SyncTeardownSentPayloadSchema: [
    [sendBase, same],
    [{ ...sendBase, targetDeviceId: "" }, refuse()],
    [{ ...sendBase, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  GitStateCoreSchema: [
    [gitCore, same],
    [{ ...gitCore, head: { kind: "detached" } }, same],
    [{ ...gitCore, indexTree: "b".repeat(64) }, same],
    [{ ...gitCore, head: { kind: "branch" } }, refuse()],
    [
      { ...gitCore, head: { kind: "detached", branch: "x" } },
      refuse('Unexpected key "branch"'),
    ],
    [{ ...gitCore, head: { kind: "other" } }, refuse()],
    [
      { ...gitCore, head: { kind: "branch", branch: "-x" } },
      refuse("Branch names cannot start with '-'"),
    ],
    [{ ...gitCore, indexTree: "a".repeat(39) }, refuse()],
    [{ ...gitCore, indexTree: "a".repeat(65) }, refuse()],
    [{ ...gitCore, tip: "zz" }, refuse("Invalid commit hash")],
    [{ ...gitCore, indexCommit: null }, refuse('Unexpected key "indexCommit"')],
  ],
  GitStateSchema: [
    [{ ...gitCore, indexCommit: c1 }, same],
    [{ ...gitCore, indexCommit: null }, same],
    [gitCore, refuse()],
    [{ ...gitCore, indexCommit: "zz" }, refuse("Invalid commit hash")],
    [
      { ...gitCore, indexCommit: null, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  MirrorWorktreePayloadSchema: [
    [pw, same],
    [{ ...pw, extra: 1 }, refuse('Unexpected key "extra"')],
    [{ projectId: "p", worktreeId: "w" }, refuse()],
    [{ projectId: "", worktreeId: wt3 }, refuse()],
  ],
  "mirror.applyGitState.input": [
    [{ ...pw, expect: { tip: c1, indexTree: tree40 }, state: gitCore }, same],
    [
      {
        ...pw,
        expect: { tip: c1, indexTree: tree40 },
        state: gitCore,
        sweep: [landing],
      },
      same,
    ],
    [
      {
        ...pw,
        expect: { tip: c1, indexTree: tree40 },
        state: gitCore,
        sweep: [mainRef],
      },
      refuse(),
    ],
    [
      {
        ...pw,
        expect: { tip: c1, indexTree: tree40 },
        state: gitCore,
        sweep: Array(9).fill(landing),
      },
      refuse(),
    ],
    [
      { ...pw, expect: { tip: c1, indexTree: tree40, x: 1 }, state: gitCore },
      refuse('Unexpected key "x"'),
    ],
    [
      {
        ...pw,
        expect: { tip: c1, indexTree: tree40 },
        state: { ...gitCore, indexCommit: null },
      },
      refuse('Unexpected key "indexCommit"'),
    ],
    [
      {
        ...pw,
        expect: { tip: c1, indexTree: tree40 },
        state: gitCore,
        extra: 1,
      },
      refuse('Unexpected key "extra"'),
    ],
  ],
  MirrorApplyGitStateResultSchema: [
    [{ applied: true }, same],
    [{ applied: false, reason: "r" }, same],
    [{ applied: true, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  MirrorSessionSchema: [
    [session, same],
    [{ ...session, git: { status: "synced", detail: "" } }, same],
    [{ ...session, lastError: "e" }, same],
    [{ ...session, git: { status: "bogus", detail: "" } }, refuse()],
    [
      { ...session, git: { status: "synced", detail: "", x: 1 } },
      refuse('Unexpected key "x"'),
    ],
    [{ ...session, status: "bogus" }, refuse()],
    [{ ...session, ignoreMode: "nothing" }, refuse()],
    [{ ...session, createdAt: -1 }, refuse()],
    [{ ...session, labels: { a: 1 } }, refuse()],
    [{ ...session, session: "" }, refuse()],
    [{ ...session, session: "s".repeat(129) }, refuse()],
    [
      { ...session, local: { ...endpoint, x: 1 } },
      refuse('Unexpected key "x"'),
    ],
    [
      {
        ...session,
        conflicts: [
          {
            root: "r",
            localChanges: [{ path: "a", kind: "renamed" }],
            remoteChanges: [],
          },
        ],
      },
      refuse(),
    ],
    [{ ...session, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "mirror.list.output": [
    [{ daemon: "running", sessions: [session], serving: [serving] }, same],
    [
      {
        daemon: "stopped",
        sessions: [],
        serving: [{ ...serving, peerWorktreeId: wt3 }],
      },
      same,
    ],
    [{ daemon: "other", sessions: [], serving: [] }, refuse()],
    [
      {
        daemon: "running",
        sessions: [],
        serving: [{ ...serving, channelId: "x" }],
      },
      refuse(),
    ],
    [
      { daemon: "running", sessions: [], serving: [{ ...serving, x: 1 }] },
      refuse('Unexpected key "x"'),
    ],
    [
      { daemon: "running", sessions: [], serving: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "mirror.changed.payload": [
    [undefined, same],
    [{ daemon: "unavailable", sessions: [], serving: [] }, same],
    [null, refuse()],
    [{}, refuse()],
  ],
  MirrorStartPayloadSchema: [
    [{ ...pullBase, ignoreMode: "everything", ignores: [] }, same],
    [{ ...pullBase, ignores: [] }, refuse()],
    [{ ...pullBase, ignoreMode: "everything" }, refuse()],
    [
      { ...pullBase, ignoreMode: "everything", ignores: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "mirror.start.output": [
    [
      { ...pulled, session: "sync_x" },
      ok({
        worktree: { ...worktree, autoPull: false },
        captured: true,
        dirtyApplied: false,
        session: "sync_x",
      }),
    ],
    [pulled, refuse()],
    [{ ...pulled, session: "" }, refuse()],
    [
      { ...pulled, session: "sync_x", extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  MirrorStartToPayloadSchema: [
    [{ ...sendBase, ignoreMode: "gitignored", ignores: [] }, same],
    [sendBase, refuse()],
    [
      { ...sendBase, ignoreMode: "gitignored", ignores: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "mirror.stop.input": [
    [{ session: "s" }, same],
    [{ session: "s", force: true }, same],
    [{ session: "" }, refuse()],
    [{ session: "s", extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "mirror.pause.input": [
    [{ session: "s" }, same],
    [{}, refuse()],
    [{ session: "s", force: true }, refuse('Unexpected key "force"')],
  ],
  "mirror.setIgnores.input": [
    [{ session: "s", ignoreMode: "gitignored", ignores: [] }, same],
    [{ session: "s", ignoreMode: "gitignored" }, refuse()],
    [
      { session: "s", ignoreMode: "gitignored", ignores: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "mirror.setIgnores.output": [
    [{ session: "s" }, same],
    [{ session: "s", extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "mirror.history.input": [
    [{ localWorktreeId: wt3 }, same],
    [{ localWorktreeId: "w" }, refuse()],
    [{ localWorktreeId: wt3, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "mirror.history.output": [
    [{ events: [] }, same],
    [{ events: [{ at: 1, kind: "started", detail: "" }] }, same],
    [{ events: events(100) }, same],
    [{ events: events(101) }, refuse()],
    [{ events: [{ at: 1, kind: "other", detail: "" }] }, refuse()],
    [{ events: [{ at: -1, kind: "started", detail: "" }] }, refuse()],
    [
      { events: [{ at: 1, kind: "started", detail: "", x: 1 }] },
      refuse('Unexpected key "x"'),
    ],
    [{ events: [], extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "mirror.openStream.input": [
    [{ ...pw, channelId: hex }, same],
    [{ ...pw, channelId: hex, peerWorktreeId: wt3 }, same],
    [{ ...pw, channelId: hex, peerWorktreeId: "w" }, refuse()],
    [{ ...pw, channelId: "x" }, refuse()],
    [{ ...pw, channelId: hex, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "control.devices.input": [
    [{}, same],
    [{ projectId: "p" }, same],
    [{ projectId: "" }, refuse()],
    [{ extra: 1 }, refuse('Unexpected key "extra"')],
    [undefined, refuse()],
  ],
  "control.devices.output": [
    [{ thisDevice: { deviceId: "d", name: "n" }, devices: [] }, same],
    [
      {
        thisDevice: { deviceId: "d", name: "n" },
        devices: [
          {
            deviceId: dev,
            name: "Mac",
            platform: "darwin",
            block: "no-grant",
            projectId: "p",
          },
          { deviceId: dev, name: "Mac", platform: "darwin" },
        ],
      },
      same,
    ],
    [
      {
        thisDevice: { deviceId: "d", name: "n" },
        devices: [{ deviceId: dev, name: "M", platform: "p", block: "x" }],
      },
      refuse(),
    ],
    [
      {
        thisDevice: { deviceId: "d", name: "n" },
        devices: [{ deviceId: "", name: "M", platform: "p" }],
      },
      refuse(),
    ],
    [
      {
        thisDevice: { deviceId: "d", name: "n" },
        devices: [{ deviceId: dev, name: "M", platform: "p", x: 1 }],
      },
      refuse('Unexpected key "x"'),
    ],
    [
      { thisDevice: { deviceId: "d", name: "n", x: 1 }, devices: [] },
      refuse('Unexpected key "x"'),
    ],
  ],
  "control.peerWorktrees.input": [
    [{ projectId: "p" }, same],
    [{ projectId: "p", device: "Mac" }, same],
    [{ projectId: "p", device: "" }, refuse()],
    [{ projectId: "p", device: "d".repeat(256) }, same],
    [{ projectId: "p", device: "d".repeat(257) }, refuse()],
    [{ projectId: "p", extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "control.peerWorktrees.output": [
    [{ worktrees: [], unreachable: [] }, same],
    [
      {
        worktrees: [
          { device: { deviceId: dev, name: "n" }, projectId: "p", worktree },
        ],
        unreachable: ["Other"],
      },
      ok({
        worktrees: [
          {
            device: { deviceId: "dev-1", name: "n" },
            projectId: "p",
            worktree: { ...worktree, autoPull: false },
          },
        ],
        unreachable: ["Other"],
      }),
    ],
    [
      {
        worktrees: [
          {
            device: { deviceId: dev, name: "n" },
            projectId: "p",
            worktree,
            x: 1,
          },
        ],
        unreachable: [],
      },
      refuse('Unexpected key "x"'),
    ],
    [
      { worktrees: [], unreachable: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "control.send.input": [
    [pw, same],
    [
      {
        ...pw,
        device: "Mac",
        mirror: true,
        leaveOut: "gitignored",
        setup: false,
        source: "teardown",
      },
      same,
    ],
    [{ ...pw, leaveOut: "everything" }, refuse()],
    [{ ...pw, source: "x" }, refuse()],
    [{ ...pw, device: "" }, refuse()],
    [{ ...pw, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "control.bring.input": [
    [{ projectId: "p", worktree: "fox" }, same],
    [
      { projectId: "p", worktree: "fox", leaveOut: "nothing", source: "keep" },
      same,
    ],
    [{ projectId: "p", worktree: "" }, refuse()],
    [{ projectId: "p", worktree: "w".repeat(513) }, refuse()],
    [
      { projectId: "p", worktree: "fox", extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "control.send.output": [
    [
      { ...pulled, device: { deviceId: dev, name: "n" }, copySide: "remote" },
      ok({
        worktree: { ...worktree, autoPull: false },
        captured: true,
        dirtyApplied: false,
        device: { deviceId: "dev-1", name: "n" },
        copySide: "remote",
      }),
    ],
    [
      {
        ...pulled,
        device: { deviceId: dev, name: "n" },
        copySide: "local",
        session: "s",
        alreadyMirrored: true,
        source: { fate: "shelve", done: false, error: "e" },
      },
      ok({
        worktree: { ...worktree, autoPull: false },
        captured: true,
        dirtyApplied: false,
        device: { deviceId: "dev-1", name: "n" },
        copySide: "local",
        session: "s",
        alreadyMirrored: true,
        source: { fate: "shelve", done: false, error: "e" },
      }),
    ],
    [
      { ...pulled, device: { deviceId: dev, name: "n" }, copySide: "x" },
      refuse(),
    ],
    [
      {
        ...pulled,
        device: { deviceId: dev, name: "n", x: 1 },
        copySide: "remote",
      },
      refuse('Unexpected key "x"'),
    ],
    [
      {
        ...pulled,
        device: { deviceId: dev, name: "n" },
        copySide: "remote",
        source: { fate: "keep", done: true, x: 1 },
      },
      refuse('Unexpected key "x"'),
    ],
    [
      {
        ...pulled,
        device: { deviceId: dev, name: "n" },
        copySide: "remote",
        extra: 1,
      },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "control.mirrors.output": [
    [{ daemon: "running", mirrors: [controlMirror] }, same],
    [
      {
        daemon: "running",
        mirrors: [{ ...controlMirror, git: "synced", gitDetail: "" }],
      },
      same,
    ],
    [
      { daemon: "running", mirrors: [{ ...controlMirror, conflicts: -1 }] },
      refuse(),
    ],
    [
      { daemon: "running", mirrors: [{ ...controlMirror, x: 1 }] },
      refuse('Unexpected key "x"'),
    ],
    [
      { daemon: "running", mirrors: [], extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "control.mirrorStop.input": [
    [pw, same],
    [{ ...pw, force: true }, same],
    [{ ...pw, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "control.mirrorStop.output": [
    [{ mirror: controlMirror }, same],
    [{ mirror: controlMirror, copyStayed: "busy" }, same],
    [{ mirror: controlMirror, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "forward.open.input": [
    [{ port: 3000, channelId: hex }, same],
    [{ port: 0, channelId: hex }, refuse()],
    [{ port: 65536, channelId: hex }, refuse()],
    [{ port: 1.5, channelId: hex }, refuse()],
    [{ port: 3000, channelId: "x" }, refuse()],
    [
      { port: 3000, channelId: hex, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "portForward.start.input": [
    [{ deviceId: dev, remotePort: 3000 }, same],
    [{ deviceId: dev, remotePort: 3000, localPort: 3001 }, same],
    [{ deviceId: dev, remotePort: 3000, localPort: 0 }, refuse()],
    [{ deviceId: "", remotePort: 3000 }, refuse()],
    [
      { deviceId: dev, remotePort: 3000, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "portForward.start.output": [
    [{ forwardId: hex, localPort: 3001 }, same],
    [
      { forwardId: hex, localPort: 3001, extra: 1 },
      refuse('Unexpected key "extra"'),
    ],
  ],
  "portForward.stop.input": [
    [{ forwardId: hex }, same],
    [{ forwardId: "x" }, refuse()],
    [{ forwardId: hex, extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  "portForward.list.output": [
    [{ forwards: [] }, same],
    [
      {
        forwards: [
          {
            forwardId: hex,
            deviceId: dev,
            remotePort: 3000,
            localPort: 3001,
            connCount: 0,
          },
        ],
      },
      same,
    ],
    [
      {
        forwards: [
          {
            forwardId: hex,
            deviceId: dev,
            remotePort: 3000,
            localPort: 3001,
            connCount: -1,
          },
        ],
      },
      refuse(),
    ],
    [{ forwards: [], extra: 1 }, refuse('Unexpected key "extra"')],
  ],
  DirectCandidateSchema: [
    [lanCandidate, same],
    [{ ...lanCandidate, url: "ws://[::1]:4000" }, same],
    [tunnelCandidate, same],
    [
      { ...lanCandidate, extra: 1 },
      ok({ kind: "lan", url: "ws://192.168.1.2:4000", ticket: "t" }),
    ],
    [
      { ...lanCandidate, url: "wss://192.168.1.2:4000" },
      refuse("candidate url does not match its kind"),
    ],
    [
      { ...lanCandidate, url: "ws://192.168.1.2" },
      refuse("candidate url does not match its kind"),
    ],
    [
      { ...lanCandidate, url: "ws://host.local:4000" },
      refuse("candidate url does not match its kind"),
    ],
    [
      { ...tunnelCandidate, url: "wss://1.2.3.4" },
      refuse("candidate url does not match its kind"),
    ],
    [
      { ...tunnelCandidate, url: "wss://a.example.com:8443" },
      refuse("candidate url does not match its kind"),
    ],
    [
      { ...tunnelCandidate, url: "ws://a.example.com" },
      refuse("candidate url does not match its kind"),
    ],
    [
      { ...lanCandidate, url: "not a url" },
      refuse("candidate url does not match its kind"),
    ],
    [{ ...lanCandidate, kind: "x" }, refuse()],
    [{ kind: "lan", url: "ws://192.168.1.2:4000" }, refuse()],
  ],
  DirectConnectInfoSchema: [
    [{ available: false }, same],
    [{ available: true, candidates: [lanCandidate, tunnelCandidate] }, same],
    [
      { available: true, candidates: [{ ...lanCandidate, kind: "tunnel" }] },
      refuse("candidate url does not match its kind"),
    ],
    [{ available: false, extra: 1 }, ok({ available: false })],
    [{}, refuse()],
  ],
  "direct.connectInfo.input": [
    [undefined, same],
    [{}, same],
    [{ dialableKinds: ["tunnel"] }, same],
    [{ dialableKinds: ["lan", "tunnel"] }, same],
    [{ dialableKinds: ["x"] }, refuse()],
    [{ extra: 1 }, ok({})],
    [null, refuse()],
  ],
  "remoteAccess.commandAccess.output": [
    [{ granted: true }, same],
    [{ granted: false, extra: 1 }, ok({ granted: false })],
    [{}, refuse()],
  ],
  ReqFrameSchema: [
    [{ t: "req", id: 1, channel: "c" }, same],
    [{ t: "req", id: 1, channel: "c", input: { a: 1 } }, same],
    [{ t: "req", id: 1, channel: "c", input: undefined }, same],
    [
      { t: "req", id: 1, channel: "c", extra: 1 },
      ok({ t: "req", id: 1, channel: "c" }),
    ],
    [{ t: "req", id: 1.5, channel: "c" }, refuse()],
    [{ t: "req", id: 1 }, refuse()],
    [{ t: "res", id: 1, channel: "c" }, refuse()],
  ],
  ClientFrameSchema: [
    [{ t: "hello", deviceId: "d", appVersion: "1" }, same],
    [{ t: "hello", token: "k", deviceId: "d", appVersion: "1" }, same],
    [
      {
        t: "hello",
        deviceId: "d",
        appVersion: "1",
        nonce: hex,
        proof: "p",
        deflate: true,
      },
      same,
    ],
    [
      { t: "hello", deviceId: "d", appVersion: "1", extra: 1 },
      ok({ t: "hello", deviceId: "d", appVersion: "1" }),
    ],
    [{ t: "hello", deviceId: "d", appVersion: "1", nonce: "x" }, refuse()],
    [{ t: "hello", appVersion: "1" }, refuse()],
    [{ t: "req", id: 2, channel: "c", input: [1] }, same],
    [{ t: "bye" }, same],
    [{ t: "bye", extra: 1 }, ok({ t: "bye" })],
    [{ t: "ping" }, same],
    [{ t: "pong" }, refuse()],
    [{ t: "welcome", deviceId: "d", appVersion: "1" }, refuse()],
    [{ t: "x" }, refuse()],
    [{}, refuse()],
    [null, refuse()],
  ],
  ServerFrameSchema: [
    [{ t: "welcome", deviceId: "d", appVersion: "1" }, same],
    [{ t: "welcome", deviceId: "d", appVersion: "1", proof: "p" }, same],
    [{ t: "challenge", nonce: hex }, same],
    [{ t: "challenge", nonce: "x" }, refuse()],
    [{ t: "res", id: 1, ok: true }, same],
    [{ t: "res", id: 1, ok: true, result: { a: [1] } }, same],
    [
      { t: "res", id: 1, ok: true, extra: 1 },
      ok({ t: "res", id: 1, ok: true }),
    ],
    [resErr, same],
    [{ ...resErr, code: "command-refused" }, same],
    [{ ...resErr, error: { _tag: "T", message: "m", extra: 1 } }, same],
    [
      { ...resErr, error: { _tag: "", message: "m" } },
      ok({ t: "res", id: 1, ok: false, message: "m", error: undefined }),
    ],
    [
      { ...resErr, error: { _tag: "T" } },
      ok({ t: "res", id: 1, ok: false, message: "m", error: undefined }),
    ],
    [
      { ...resErr, error: 5 },
      ok({ t: "res", id: 1, ok: false, message: "m", error: undefined }),
    ],
    [
      { ...resErr, error: null },
      ok({ t: "res", id: 1, ok: false, message: "m", error: undefined }),
    ],
    [{ ...resErr, error: undefined }, same],
    [
      { ...resErr, code: "c", error: "x" },
      ok({
        t: "res",
        id: 1,
        ok: false,
        message: "m",
        code: "c",
        error: undefined,
      }),
    ],
    [{ ...resErr, code: 5 }, refuse()],
    [{ t: "res", id: 1, ok: false }, refuse()],
    [{ t: "res", id: 1, ok: "yes" }, refuse()],
    [{ t: "res", id: 1.5, ok: true }, refuse()],
    [{ t: "res", id: 1 }, refuse()],
    [{ t: "push", channel: "c" }, same],
    [
      { t: "push", channel: "c", payload: { a: 1 }, extra: 1 },
      ok({ t: "push", channel: "c", payload: { a: 1 } }),
    ],
    [{ t: "pong" }, same],
    [{ t: "ping" }, refuse()],
    [{ t: "hello", deviceId: "d", appVersion: "1" }, refuse()],
    [{ t: "x" }, refuse()],
    [null, refuse()],
  ],
  WireErrorShapeSchema: [
    [{ _tag: "T", message: "m" }, same],
    [
      { _tag: "T", message: "m", worktreeId: "w1", n: 2, nested: { a: [1] } },
      same,
    ],
    [{ _tag: "", message: "m" }, refuse()],
    [{ message: "m" }, refuse()],
    [{ _tag: 3, message: "m" }, refuse()],
    [{ _tag: "T" }, refuse()],
    [{ _tag: "T", message: 3 }, refuse()],
    [null, refuse()],
    ["T", refuse()],
  ],
  DeviceIdSchema: [
    ["d", same],
    ["x".repeat(200), same],
    ["", refuse()],
    ["x".repeat(201), refuse()],
    [5, refuse()],
  ],
  ErrorBodySchema: [
    [{ error: "e" }, same],
    [{ error: "e", code: "device_revoked" }, same],
    [{ error: "e", code: "other" }, refuse()],
    [{ error: "e", extra: 1 }, ok({ error: "e" })],
    [{}, refuse()],
  ],
  EnrollRequestSchema: [
    [{ deviceId: dev, name: "Mac", platform: "darwin" }, same],
    [
      {
        deviceId: "x".repeat(200),
        name: "n".repeat(256),
        platform: "p".repeat(64),
      },
      same,
    ],
    [{ deviceId: "x".repeat(201), name: "n", platform: "p" }, refuse()],
    [{ deviceId: dev, name: "n".repeat(257), platform: "p" }, refuse()],
    [{ deviceId: dev, name: "n", platform: "p".repeat(65) }, refuse()],
    [{ deviceId: dev, name: "", platform: "p" }, refuse()],
    [{ deviceId: "", name: "n", platform: "p" }, refuse()],
    [
      { deviceId: dev, name: "n", platform: "p", extra: 1 },
      ok({ deviceId: "dev-1", name: "n", platform: "p" }),
    ],
    [{ deviceId: dev, name: "n" }, refuse()],
  ],
  RenameDeviceRequestSchema: [
    [{ name: "n" }, same],
    [{ name: "n".repeat(257) }, refuse()],
    [{ name: "" }, refuse()],
    [{ name: "n", extra: 1 }, ok({ name: "n" })],
  ],
  DeviceInfoSchema: [
    [deviceInfo, same],
    [{ ...deviceInfo, lastSeenAt: 2 }, same],
    [
      { ...deviceInfo, credential: "secret" },
      ok({
        deviceId: "dev-1",
        name: "Mac",
        platform: "darwin",
        createdAt: 1,
        lastSeenAt: null,
        online: true,
      }),
    ],
    [{ ...deviceInfo, createdAt: 1.5 }, refuse()],
    [{ ...deviceInfo, lastSeenAt: undefined }, refuse()],
    [{ ...deviceInfo, online: undefined }, refuse()],
  ],
  EnrollResponseSchema: [
    [{ credential: "c", device: deviceInfo }, same],
    [
      { credential: "c", device: { ...deviceInfo, x: 1 }, extra: 1 },
      ok({
        credential: "c",
        device: {
          deviceId: "dev-1",
          name: "Mac",
          platform: "darwin",
          createdAt: 1,
          lastSeenAt: null,
          online: true,
        },
      }),
    ],
    [{ device: deviceInfo }, refuse()],
  ],
  DeviceListResponseSchema: [
    [{ devices: [] }, same],
    [
      { devices: [deviceInfo, { ...deviceInfo, x: 1 }] },
      ok({
        devices: [
          {
            deviceId: "dev-1",
            name: "Mac",
            platform: "darwin",
            createdAt: 1,
            lastSeenAt: null,
            online: true,
          },
          {
            deviceId: "dev-1",
            name: "Mac",
            platform: "darwin",
            createdAt: 1,
            lastSeenAt: null,
            online: true,
          },
        ],
      }),
    ],
    [{ devices: {} }, refuse()],
  ],
  TicketResponseSchema: [
    [{ ticket: "t", expiresInMs: 60000 }, same],
    [{ ticket: "t", expiresInMs: 1.5 }, refuse()],
    [
      { ticket: "t", expiresInMs: 60000, extra: 1 },
      ok({ ticket: "t", expiresInMs: 60000 }),
    ],
    [{ ticket: "t" }, refuse()],
  ],
  TunnelProvisionRequestSchema: [
    [{ port: 3000 }, same],
    [{ port: 1 }, same],
    [{ port: 65535 }, same],
    [{ port: 0 }, refuse()],
    [{ port: 65536 }, refuse()],
    [{ port: 1.5 }, refuse()],
    [{ port: "3000" }, refuse()],
    [{ port: 3000, extra: 1 }, ok({ port: 3000 })],
  ],
  TunnelProvisionResponseSchema: [
    [{ hostname: "h", connectorToken: "t" }, same],
    [{ hostname: "h", connectorToken: "t", dnsCreated: true }, same],
    [{ hostname: "", connectorToken: "t" }, refuse()],
    [{ hostname: "h", connectorToken: "" }, refuse()],
    [
      { hostname: "h", connectorToken: "t", extra: 1 },
      ok({ hostname: "h", connectorToken: "t" }),
    ],
  ],
  DeviceEnvelopeSchema: [
    [{ t: "relay", to: dev, frame: { a: 1 } }, same],
    [{ t: "relay", to: dev }, refuse()],
    [
      { t: "relay", to: dev, frame: null, extra: 1 },
      ok({ t: "relay", to: "dev-1", frame: null }),
    ],
    [{ t: "relay", to: "", frame: 1 }, refuse()],
    [{ t: "relay", to: "x".repeat(201), frame: 1 }, refuse()],
    [{ t: "nack", to: dev, reason: "offline" }, refuse()],
    [null, refuse()],
  ],
  ServerEnvelopeSchema: [
    [{ t: "relay", from: dev, frame: { epoch: 1, sm: { t: "bye" } } }, same],
    [{ t: "relay", from: dev }, refuse()],
    [{ t: "relay", from: "x".repeat(201), frame: 1 }, refuse()],
    [{ t: "presence", online: [] }, same],
    [{ t: "presence", online: Array(64).fill(dev) }, same],
    [{ t: "presence", online: Array(65).fill(dev) }, refuse()],
    [{ t: "presence", online: [""] }, refuse()],
    [{ t: "nack", to: dev, reason: "offline" }, same],
    [
      { t: "nack", to: dev, reason: "too-large", extra: 1 },
      ok({ t: "nack", to: "dev-1", reason: "too-large" }),
    ],
    [{ t: "nack", to: dev, reason: "x" }, refuse()],
    [{ t: "nack", to: "", reason: "offline" }, refuse()],
    [{ t: "x" }, refuse()],
    [null, refuse()],
  ],
  "account.listDevices.output": [
    [[], same],
    [
      [deviceInfo, { ...deviceInfo, x: 1 }],
      ok([
        {
          deviceId: "dev-1",
          name: "Mac",
          platform: "darwin",
          createdAt: 1,
          lastSeenAt: null,
          online: true,
        },
        {
          deviceId: "dev-1",
          name: "Mac",
          platform: "darwin",
          createdAt: 1,
          lastSeenAt: null,
          online: true,
        },
      ]),
    ],
    [[{ ...deviceInfo, online: "yes" }], refuse()],
  ],
  "hub.invokePeer.input": [
    [{ deviceId: dev, channel: "c" }, same],
    [{ deviceId: dev, channel: "c", input: { a: 1 } }, same],
    [{ deviceId: dev, channel: "c", input: undefined }, same],
    [{ deviceId: dev, channel: "" }, refuse()],
    [{ deviceId: "x".repeat(201), channel: "c" }, refuse()],
    [
      { deviceId: dev, channel: "c", extra: 1 },
      ok({ deviceId: "dev-1", channel: "c" }),
    ],
  ],
};

// Each wave-3 void slot answered undefined, and refused everything else.
const VOID_SLOTS_WAVE3 = [
  "sync.bundleAbort.output",
  "sync.pushChunk.output",
  "mirror.list.input",
  "mirror.stop.output",
  "mirror.pause.output",
  "mirror.resume.output",
  "mirror.openStream.output",
  "control.mirrors.input",
  "forward.open.output",
  "portForward.stop.output",
  "portForward.list.input",
  "portForward.changed.payload",
  "remoteAccess.commandAccess.input",
  "remoteAccess.commandAccessChanged.payload",
];

// The shared leave-out preset, read through parseLeaveOutPreset: a bad
// path is dropped and the rest kept, anything else unreadable is the
// dialogs' default.
const LEAVE_OUT_PRESETS = [
  [
    '{"base":"everything"}',
    ok({ base: "everything", leftOut: [], brought: [] }),
  ],
  [
    '{"base":"gitignored","brought":["dist",".env"]}',
    ok({ base: "gitignored", leftOut: [], brought: ["dist", ".env"] }),
  ],
  [
    '{"base":"everything","leftOut":["dist","../x","/abs","a\\nb",5,"",null,"ok/y"],"brought":["b"]}',
    ok({ base: "everything", leftOut: ["dist", "ok/y"], brought: ["b"] }),
  ],
  [
    '{"base":"everything","leftOut":[],"extra":1}',
    ok({ base: "everything", leftOut: [], brought: [] }),
  ],
  ['{"base":"nothing"}', ok({ base: "everything", leftOut: [], brought: [] })],
  [
    '{"base":"everything","leftOut":null}',
    ok({ base: "everything", leftOut: [], brought: [] }),
  ],
  [
    '{"base":"everything","leftOut":"dist"}',
    ok({ base: "everything", leftOut: [], brought: [] }),
  ],
  ["[]", ok({ base: "everything", leftOut: [], brought: [] })],
  ["null", ok({ base: "everything", leftOut: [], brought: [] })],
  ["not json", ok({ base: "everything", leftOut: [], brought: [] })],
  [undefined, ok({ base: "everything", leftOut: [], brought: [] })],
];

const WAVE3_EXPORTS = {
  ...syncModule,
  ...mirrorModule,
  ...directModule,
  ...protocol,
  ...frames,
  WireErrorShapeSchema,
  HexId32Schema,
};
const WAVE3_CONTRACTS = {
  sync: syncModule.syncContract,
  mirror: mirrorModule.mirrorContract,
  control: controlContract,
  forward: forwardContract,
  portForward: portForwardContract,
  direct: directModule.directContract,
  remoteAccess: remoteAccessContract,
  account: accountContract,
  hub: hubContract,
};

function wave3Codec(label) {
  if (label in WAVE3_EXPORTS) return WAVE3_EXPORTS[label];
  const [module, call, slot] = label.split(".");
  return WAVE3_CONTRACTS[module].calls[call][slot];
}

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
    }
  });

  for (const [name, rows] of Object.entries(RECORDED)) {
    // oxlint-disable-next-line no-await-in-loop -- one named check per schema, in table order
    await check(`${name} matches zod`, () => {
      assertCases(schemas[name], rows);
    });
  }

  for (const [label, rows] of Object.entries(RECORDED_WAVE2)) {
    // oxlint-disable-next-line no-await-in-loop -- one named check per schema, in table order
    await check(`${label} matches zod`, () => {
      assertCases(wave2Codec(label), rows);
    });
  }

  await check("wave 2's void slots take undefined alone", () => {
    for (const label of VOID_SLOTS) {
      const codec = wave2Codec(label);
      assert.equal(codec, Schema.Undefined, `${label} is Schema.Undefined`);
      assertCases(codec, VOID_ROWS);
    }
  });

  for (const [label, rows] of Object.entries(RECORDED_WAVE3)) {
    // oxlint-disable-next-line no-await-in-loop -- one named check per schema, in table order
    await check(`${label} matches zod`, () => {
      assertCases(wave3Codec(label), rows);
    });
  }

  await check("wave 3's void slots take undefined alone", () => {
    for (const label of VOID_SLOTS_WAVE3) {
      const codec = wave3Codec(label);
      assert.equal(codec, Schema.Undefined, `${label} is Schema.Undefined`);
      assertCases(codec, VOID_ROWS);
    }
  });

  await check("the leave-out preset reads as zod read it", () => {
    for (const [value, recorded] of LEAVE_OUT_PRESETS) {
      assert.deepStrictEqual(
        parseLeaveOutPreset(value),
        recorded.ok,
        `preset ${describe(value)}`,
      );
    }
  });

  await check(
    "the wire's strict payloads refuse an undeclared key by name, through Schema.is too",
    () => {
      const pull = syncModule.SyncPullWorktreePayloadSchema;
      const base = {
        sourceDeviceId: "d",
        sourceProjectId: "p",
        sourceWorktreeId: "0123456789ab",
        sourceIdentity: "i",
        branch: "main",
      };
      assert.equal(
        safeDecodeWith(pull, { ...base, sneaky: 1 }).error?.message,
        'Unexpected key "sneaky"\n  at ["sneaky"]',
      );
      assert.equal(Schema.is(pull)({ ...base, sneaky: 1 }), false);
      assert.equal(Schema.is(pull)(base), true);
      // A strict struct built by spreading another's fields is strict
      // too (zod's .extend kept the strictness).
      assert.equal(
        safeDecodeWith(mirrorModule.MirrorStartPayloadSchema, {
          ...base,
          ignoreMode: "everything",
          ignores: [],
          sneaky: 1,
        }).error?.message,
        'Unexpected key "sneaky"\n  at ["sneaky"]',
      );
      // Nested: the landing capture is strict at its own level.
      assert.match(
        String(
          safeDecodeWith(syncModule.SyncLandWorktreePayloadSchema, {
            identity: "i",
            branch: "main",
            branchTip: "abc1234",
            capture: {
              sourceWorktreeId: "0123456789ab",
              commit: "abc1234",
              sneaky: 1,
            },
          }).error?.message,
        ),
        /Unexpected key "sneaky"\n {2}at \["capture"\]\["sneaky"\]/,
      );
    },
  );

  await check(
    "a res frame keeps parsing whatever its error field holds",
    () => {
      const Server = frames.ServerFrameSchema;
      // An old peer: the message, maybe a code, no typed error.
      const old = decodeWith(Server, {
        t: "res",
        id: 1,
        ok: false,
        message: "m",
        code: "command-refused",
      });
      assert.equal(Object.hasOwn(old, "error"), false);
      assert.equal(old.code, "command-refused");
      // A newer peer's shape this build cannot read degrades to
      // undefined, and the frame is still the caller's answer.
      for (const error of [{ _tag: "", message: "m" }, 5, null, "x", []]) {
        const degraded = decodeWith(Server, {
          t: "res",
          id: 1,
          ok: false,
          message: "m",
          error,
        });
        assert.equal(degraded.error, undefined, describe(error));
        assert.equal(degraded.message, "m");
      }
      // Through the one frame reader, from text, the same.
      const text = JSON.stringify({
        t: "res",
        id: 9,
        ok: false,
        message: "m",
        error: { _tag: 3 },
      });
      const read = frames.decodeFrame(text, Server);
      assert.equal(read?.t, "res");
      assert.equal(read?.error, undefined);
      assert.equal(frames.decodeFrame("{", Server), null);
      assert.equal(frames.decodeFrame('{"t":"res"}', Server), null);
    },
  );

  await check(
    "the remote device-settings patch refuses socketHost by name",
    () => {
      const SOCKET_HOST = 'Unexpected key "socketHost"';
      const patch = schemas.DeviceSettingsPatchSchema;
      const payload = schemas.WriteDeviceSettingsPayloadSchema;
      const wireInput = globalConfigContract.calls.writeDeviceSettings.input;
      assert.equal(wireInput, payload, "the contract takes the payload");
      const carrying = { socketHost: { enabled: true, lan: true, token: "x" } };
      assert.equal(
        safeDecodeWith(patch, carrying).error?.message,
        `${SOCKET_HOST}\n  at ["socketHost"]`,
      );
      assert.equal(
        safeDecodeWith(patch, { ...carrying, launchScripts: true }).error
          ?.message,
        `${SOCKET_HOST}\n  at ["socketHost"]`,
      );
      assert.equal(
        safeDecodeWith(wireInput, { patch: carrying }).error?.message,
        `${SOCKET_HOST}\n  at ["patch"]["socketHost"]`,
      );
      assert.throws(
        () => decodeWith(wireInput, { patch: { socketHost: {} } }),
        (error) => error.message.includes(SOCKET_HOST),
      );
      // A guard cannot pass it either.
      assert.equal(Schema.is(patch)(carrying), false);
      assert.equal(Schema.is(payload)({ patch: carrying }), false);
      // Every other key outside the managed set, by name too.
      for (const key of [
        "remoteDevices",
        "directConnections",
        "cloudflaredPath",
        "theme",
      ]) {
        assert.match(
          String(safeDecodeWith(patch, { [key]: true }).error?.message),
          new RegExp(`Unexpected key "${key}"`),
        );
      }
      // The managed keys are picked, not respelled: each is the full
      // config's own field schema, so a managed key's shape cannot drift
      // between the local write and the remote patch.
      assert.deepStrictEqual(
        Object.keys(patch.fields).toSorted(),
        Object.keys(patchKeys).toSorted(),
      );
      for (const key of Object.keys(patchKeys)) {
        assert.equal(
          patch.fields[key],
          schemas.GlobalConfigSchema.fields[key],
          `${key} is GlobalConfigSchema's field`,
        );
      }
      assert.deepStrictEqual(decodeWith(wireInput, { patch: patchKeys }), {
        patch: patchKeys,
      });
      // The whole-document local write still strips instead.
      assert.deepStrictEqual(
        decodeWith(schemas.WriteGlobalConfigPayloadSchema, {
          config: { launchScripts: true, remoteDevices: [] },
        }),
        { config: { launchScripts: true } },
      );
    },
  );

  await check(
    "the shared settings document keeps zod's lenient per-entry read",
    () => {
      const Doc = schemas.SharedSettingsDocSchema;
      // Past the entry cap, with an unreadable entry every hundred: the
      // first 512 readable ones in the document's own order are kept,
      // and no unreadable one costs a readable one its place. Recorded
      // against zod: 512 kept, k0 to k511, no bad key.
      const big = {};
      for (let at = 0; at < 600; at += 1) {
        big[`k${at}`] = { value: at, at: 1, by: "d" };
        if (at % 100 === 0) big[`bad${at}`] = { value: {}, at: 1, by: "d" };
      }
      const kept = Object.keys(decodeWith(Doc, { entries: big }).entries);
      assert.equal(kept.length, schemas.MAX_SHARED_SETTING_ENTRIES);
      assert.deepStrictEqual(
        kept,
        Array.from({ length: 512 }, (_, at) => `k${at}`),
      );
      // One unreadable entry never fails the document, whatever it is.
      for (const bad of [
        5,
        null,
        "x",
        [],
        { value: {}, at: 1, by: "d" },
        { value: "v", at: -1, by: "d" },
        { value: "v", at: 1, by: "" },
      ]) {
        assert.deepStrictEqual(
          decodeWith(Doc, { entries: { bad, k: entry } }),
          { entries: { k: entry } },
          `${describe(bad)} is left out`,
        );
      }
      // A `__proto__` key (JSON.parse makes it own) is left out as zod
      // left it out, and never becomes the entries' prototype.
      const proto = decodeWith(
        Doc,
        JSON.parse(
          '{"entries":{"__proto__":{"value":1,"at":1,"by":"k"},"k":{"value":1,"at":1,"by":"k"}}}',
        ),
      );
      assert.deepStrictEqual(Object.keys(proto.entries), ["k"]);
      assert.equal(Object.getPrototypeOf(proto.entries), Object.prototype);
      assert.equal({}.value, undefined, "Object.prototype untouched");
      // Decoded, the document is its own type: the dev output check and
      // a broadcast validate it without running the read a second time.
      const doc = decodeWith(Doc, { entries: { k: entry, bad: 5 } });
      assert.equal(Schema.is(Doc)(doc), true);
      assert.equal(validateWith(Doc, doc), doc);
      // The contract's slots are the same document.
      for (const slot of [
        sharedSettingsContract.calls.read.output,
        sharedSettingsContract.calls.set.output,
        sharedSettingsContract.calls.merge.output,
        sharedSettingsContract.calls.changed.payload,
      ]) {
        assert.equal(slot, Doc);
      }
    },
  );

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
    "the web stub walker answers every channel as the zod walker did",
    () => {
      // Recorded against the zod walker (every contract read, the
      // unclassified client channels, and a few mutations for the
      // fabricated arms the lab relies on): [channel, the structural
      // answer, the answer with fabricateArms when it differs].
      const recorded = [
        [
          "account:status",
          {
            configured: false,
            signedIn: false,
            accountId: "",
            deviceName: "",
            sharedSignIn: false,
          },
        ],
        [
          "account:enroll",
          {
            configured: false,
            signedIn: false,
            accountId: "",
            deviceName: "",
            sharedSignIn: false,
          },
        ],
        ["account:signOut", undefined],
        ["account:revokeDevice", undefined],
        ["account:listDevices", []],
        [
          "account:setDeviceName",
          {
            configured: false,
            signedIn: false,
            accountId: "",
            deviceName: "",
            sharedSignIn: false,
          },
        ],
        ["account:acceptsCommands", false],
        ["account:setAcceptsCommands", undefined],
        ["clientConfig:read", {}],
        ["clientConfig:write", undefined],
        ["dialog:pickFolder", ""],
        ["direct:connectInfo", { available: false }],
        ["git:sweep", { leaseMs: 0 }],
        ["githubCli:readiness", { installed: false, authed: false }],
        ["githubCli:projectPullRequests", {}],
        ["githubCli:worktreePullRequest", null],
        [
          "githubCli:pullRequestCandidates",
          NO_STRUCTURAL_STUB,
          { status: "ok", pullRequests: [] },
        ],
        ["githubCli:repoMergeConfig", null],
        ["githubCli:pullRequestDiff", ""],
        ["globalConfig:read", {}],
        ["globalConfig:readLocal", {}],
        ["hygiene:list", []],
        [
          "hygiene:diskUsage",
          { worktreeId: "", bytes: 0, lastActivityAt: 0, partial: false },
        ],
        ["launchers:detect", []],
        ["launchers:forProject", { entries: [], hiddenCount: 0 }],
        ["launchers:launch", undefined],
        ["menu:setLaunchToolsEnabled", undefined],
        [
          "mirror:list",
          NO_STRUCTURAL_STUB,
          { daemon: "stopped", sessions: [], serving: [] },
        ],
        ["mirror:history", { events: [] }],
        [
          "mirror:gitState",
          NO_STRUCTURAL_STUB,
          {
            head: { kind: "branch", branch: "unavailable" },
            tip: "unavailable",
            indexTree: "unavailable",
            indexCommit: null,
          },
        ],
        ["packageScripts:list", null],
        ["packageScripts:getSort", NO_STRUCTURAL_STUB, "manifest"],
        [
          "portForward:start",
          NO_STRUCTURAL_STUB,
          { forwardId: "unavailable", localPort: 0 },
        ],
        ["portForward:stop", undefined],
        ["portForward:list", { forwards: [] }],
        ["portPool:isActive", false],
        ["portPool:isInstalled", false],
        ["ports:list", { ports: [] }],
        ["projects:list", []],
        ["projects:add", { id: "", name: "", path: "" }],
        ["projects:getSort", NO_STRUCTURAL_STUB, "alphabetical"],
        ["projects:getCollapsed", []],
        ["projects:defaultBranch", ""],
        ["projects:cloneUrl", ""],
        ["projects:listBranches", { local: [], remote: [] }],
        ["projects:pickWorktreeName", ""],
        [
          "projects:worktreeIncludeStatus",
          { fileExists: false, matchedPaths: [] },
        ],
        ["projects:carryOverListing", []],
        ["projects:carryOverStats", {}],
        ["projects:icon", null],
        [
          "hub:status",
          NO_STRUCTURAL_STUB,
          {
            socket: { phase: "idle" },
            onlineDeviceIds: [],
            peerAppVersions: {},
          },
        ],
        ["hub:invokePeer", undefined],
        ["remoteAccess:commandAccess", { granted: false }],
        [
          "runtime:info",
          NO_STRUCTURAL_STUB,
          {
            dataDir: "unavailable",
            dataDirSource: "env",
            atDefaultDataDir: false,
            canonicalDataDirName: "unavailable",
            homedir: "unavailable",
          },
        ],
        ["runtime:nuke", undefined],
        ["scripts:cancel", { cancelled: false }],
        ["scripts:orphanReport", { stopped: 0 }],
        ["sharedSettings:read", { entries: {} }],
        [
          "cli:status",
          NO_STRUCTURAL_STUB,
          {
            name: "",
            aliasName: "",
            binDir: "",
            linkPath: "",
            state: "installed",
            foreignPaths: [],
            onPath: false,
          },
        ],
        ["cli:shellStatus", { loginShell: "", shells: [] }],
        ["shell:openExternal", undefined],
        ["shell:showItemInFolder", undefined],
        ["terrier:readiness", { installed: false, compatible: false }],
        ["shigomori:read", null],
        ["worktreeData:read", null],
        ["sync:pushStart", NO_STRUCTURAL_STUB, { transferId: "unavailable" }],
        ["sync:landCheck", NO_STRUCTURAL_STUB, { projectId: "unavailable" }],
        ["updater:get", NO_STRUCTURAL_STUB, { kind: "unsupported" }],
        ["window:previewTheme", undefined],
        ["window:relaunch", undefined],
        ["worktrees:list", []],
        ["worktrees:delete", NO_STRUCTURAL_STUB, { ok: true }],
        ["worktrees:fileDiff", ""],
        ["worktrees:changeStatus", []],
        ["worktrees:commitMessage", { summary: "", description: "" }],
        ["worktrees:commitDiff", ""],
        ["worktrees:listCommits", []],
      ];
      const defs = new Map();
      for (const module of allContractModules) {
        for (const def of Object.values(module.calls)) {
          if (def.kind === "invoke") defs.set(def.channel, def);
        }
      }
      for (const [channel, structural, fabricated = structural] of recorded) {
        const def = defs.get(channel);
        assert.ok(def, `${channel} is not a contract invoke`);
        assert.deepStrictEqual(
          stubValueFor(def.output, { fabricateArms: false }),
          structural,
          `${channel}'s structural stub`,
        );
        assert.deepStrictEqual(
          stubValueFor(def.output, { fabricateArms: true }),
          fabricated,
          `${channel}'s fabricated stub`,
        );
      }
      // Every other channel answers without throwing, a stub or the
      // sentinel.
      for (const def of defs.values()) {
        stubValueFor(def.output, { fabricateArms: false });
        stubValueFor(def.output, { fabricateArms: true });
      }
      // A candidate list with no arm fabricated stays refused: its
      // status union has no plain empty.
      assert.equal(
        stubValueFor(schemas.PullRequestCandidateListSchema, {
          fabricateArms: false,
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
