// The mirror engine's figures for a posed session, and a session and
// its history as they stand once a mirror has run a while, for a
// picture with no fake engine behind it (../scenes).
import type {
  MirrorEvent,
  MirrorSession,
} from "@shigomori/contracts/modules/mirror";
import type { Worktree } from "@shigomori/contracts/schemas/index";

export const endpointState = () => ({
  connected: true,
  scanned: true,
  directories: 42,
  files: 318,
  symbolicLinks: 0,
  totalFileSize: 4_820_000,
  problems: [],
  excludedProblems: 0,
});

const HOUR = 3_600_000;

// `original` kept in step with `copy` on `copyDeviceId`, settled and
// watching, a few hours in.
export function mirrorSessionFixture(
  original: Worktree,
  copyDeviceId: string,
  copy: Worktree,
): MirrorSession {
  return {
    session: "sync_1",
    name: original.branch,
    labels: { mode: "mirror" },
    localRoot: original.path,
    localProjectId: original.projectId,
    localWorktreeId: original.id,
    deviceId: copyDeviceId,
    projectId: copy.projectId,
    worktreeId: copy.id,
    remoteRoot: copy.path,
    paused: false,
    ignores: [],
    ignoreMode: "gitignored",
    createdAt: Date.now() - 3 * HOUR,
    status: "watching",
    statusText: "Watching for changes",
    successfulCycles: 128,
    conflicts: [],
    excludedConflicts: 0,
    local: endpointState(),
    remote: endpointState(),
    git: { status: "synced", detail: "both sides at 58c21fe" },
  };
}

// The thread a mirror like that has gathered, newest first.
export function mirrorHistoryFixture(): MirrorEvent[] {
  const now = Date.now();
  return [
    { at: now - 20 * 60_000, kind: "conflict", detail: "renderer/index.css" },
    { at: now - 70 * 60_000, kind: "recovered", detail: "" },
    {
      at: now - 75 * 60_000,
      kind: "disconnected",
      detail: "Thinkpad went to sleep",
    },
    { at: now - 2 * HOUR, kind: "ignores-changed", detail: "gitignored" },
    { at: now - 3 * HOUR, kind: "connected", detail: "" },
    { at: now - 3 * HOUR, kind: "started", detail: "gitignored" },
  ];
}
