// The mirror daemon's slot and the vocabulary around it: the labels the
// start orchestration writes on a session, the raw shapes the daemon
// reports, and the impl main wires in following the setPortForwardEngine
// precedent. Separate from the mirror handler module so the worktree
// tombstone protocol (host/lib/scripts/index.ts withDeleteInflight)
// can stop a worktree's mirrors without importing that module (which
// reaches sync, which reaches worktrees).
import type {
  MirrorGitStatus,
  MirrorSession,
} from "@shared/ipc/modules/mirror";
import { errorMessageOf } from "@shared/errors";

// The label keys the start orchestration writes on a session, lifted
// back out for the renderer by annotate below. Labels are the one
// free-form slot Mutagen persists with a session, so they survive a
// daemon restart without any bookkeeping of our own. Ids only: the
// engine refuses label values outside its alphabet, and the branch is
// the local worktree's to report.
export const MIRROR_LABEL_LOCAL_PROJECT = "localProjectId";
export const MIRROR_LABEL_LOCAL_WORKTREE = "localWorktreeId";

// What the daemon reports for one session, before annotation: the
// daemon's own document shape (file-sync/engine.go mirrorSessionState).
export type MirrorSessionRaw = Omit<
  MirrorSession,
  "localProjectId" | "localWorktreeId"
>;

// The create request the daemon takes (file-sync/engine.go
// mirrorRequest, the create fields).
export type MirrorCreateInput = {
  localRoot: string;
  deviceId: string;
  projectId: string;
  worktreeId: string;
  remoteRoot: string;
  name: string;
  labels: Record<string, string>;
};

export type MirrorImpl = {
  status: () => "stopped" | "starting" | "running" | "unavailable";
  sessions: () => MirrorSessionRaw[];
  create: (input: MirrorCreateInput) => Promise<string>;
  terminate: (session: string) => Promise<unknown>;
  pause: (session: string) => Promise<unknown>;
  resume: (session: string) => Promise<unknown>;
  // The git follower's verdict for a session (host/mirror/gitFollow.ts).
  gitStatus: (session: string) => MirrorGitStatus | undefined;
};

let impl: MirrorImpl | null = null;

export function setMirrorImpl(next: MirrorImpl): void {
  impl = next;
}

export function engine(): MirrorImpl {
  if (impl === null) {
    throw new Error("mirror handler invoked before the daemon was wired");
  }
  return impl;
}

// Every session whose local side is the named worktree, stopped. The
// tombstone protocol calls this once a delete or a relocate has gone
// through (withDeleteInflight says why after and not before): left
// alone, the session sits halted on a root that is gone or moved and
// the peer keeps calling its worktree mirrored. It goes through the
// injected impl, the one mirror:stop uses, so the git follower forgets
// the session too. A relocate changes the worktree id (it is path
// derived), but the label still carries the old one, which is what
// the caller passes.
//
// A session that refuses to stop is logged, not thrown: the delete is
// what was asked for, and a stuck mirror must not be what blocks it.
export async function stopMirrorsForWorktree(
  localWorktreeId: string,
): Promise<void> {
  const daemon = impl;
  // Unwired (a check, a surface that never mounts the daemon) there is
  // nothing mirroring anything.
  if (daemon === null) return;
  const doomed = daemon
    .sessions()
    .filter(
      (raw) => raw.labels[MIRROR_LABEL_LOCAL_WORKTREE] === localWorktreeId,
    );
  await Promise.all(
    doomed.map((raw) =>
      daemon.terminate(raw.session).catch((error: unknown) => {
        console.warn(
          `[mirror] could not stop the mirror of a worktree being deleted: ${errorMessageOf(error)}`,
        );
      }),
    ),
  );
}
