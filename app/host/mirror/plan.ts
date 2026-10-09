// The mirror's decisions before it acts (host/mirror/sessions.ts acts
// on them): whether a worktree may start a mirror, what a session's
// labels say, and how a session reads on the list. Pure.
import * as Schema from "effect/Schema";
import {
  MIRROR_LABEL_MODE,
  type MirrorGitStatus,
  type MirrorIgnoreMode,
  type MirrorSession,
  MirrorSessionSchema,
} from "@shigomori/contracts/modules/mirror";
import {
  carriedLabels,
  ignoreModeOf,
  localWorktreeIdOf,
  MIRROR_LABEL_IGNORE_MODE,
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  type MirrorCreateInput,
  type MirrorSessionRaw,
} from "./registry";

const decodeMirrorSession = Schema.decodeUnknownSync(MirrorSessionSchema);

// One mirror per worktree: a worktree that already runs a session is
// mirrored, and one a peer mirrors into (it serves the stream, or holds
// the invitation of a mirror it asked for) is a copy, which a second
// mirror would chain off. Either start would only fail later on the
// branch, or worse, land. Null when the worktree may start one.
export function mirrorStartRefusal(
  worktreeId: string,
  held: {
    readonly sessions: readonly MirrorSessionRaw[];
    readonly servedWorktreeIds: readonly string[];
    readonly invitedCopyIds: readonly (string | undefined)[];
  },
): string | null {
  if (held.sessions.some((raw) => localWorktreeIdOf(raw) === worktreeId)) {
    return "This worktree is already mirrored. Open its Mirror button to manage that one.";
  }
  if (
    held.servedWorktreeIds.includes(worktreeId) ||
    held.invitedCopyIds.includes(worktreeId)
  ) {
    return "This worktree is a mirror's copy. Mirror the original instead.";
  }
  return null;
}

// The labels a start writes: the original's ids here, the rule, and
// the mode (a primary checkout's copy sits on mirror/<branch>).
export function startLabels(
  source: { projectId: string; id: string; isPrimary: boolean },
  ignoreMode: MirrorIgnoreMode,
): Record<string, string> {
  return {
    [MIRROR_LABEL_LOCAL_PROJECT]: source.projectId,
    [MIRROR_LABEL_LOCAL_WORKTREE]: source.id,
    [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
    [MIRROR_LABEL_MODE]: source.isPrimary ? "mirror-branch" : "mirror",
  };
}

// The session an ignore change re-opens on the same pair: the old one's
// labels carried over, with the new rule and the session it replaces.
export function reopenInput(
  raw: MirrorSessionRaw,
  ignoreMode: MirrorIgnoreMode,
  ignores: readonly string[],
): MirrorCreateInput {
  return {
    localRoot: raw.localRoot,
    deviceId: raw.deviceId,
    projectId: raw.projectId,
    worktreeId: raw.worktreeId,
    remoteRoot: raw.remoteRoot,
    name: raw.name,
    localWorktreeId: localWorktreeIdOf(raw),
    labels: carriedLabels(raw, { [MIRROR_LABEL_IGNORE_MODE]: ignoreMode }),
    ignores: [...ignores],
  };
}

// The daemon's document with the two label-borne ids lifted to fields.
// The daemon validates each line on arrival (host/mirror/
// daemon.ts). This checks the annotated whole against the contract, a
// backstop for what the host attaches and for an impl that is not the
// daemon (the proofs' fakes).
export function annotateMirrorSession(
  raw: MirrorSessionRaw,
  git?: MirrorGitStatus,
): MirrorSession {
  return decodeMirrorSession({
    ...raw,
    localProjectId: raw.labels[MIRROR_LABEL_LOCAL_PROJECT] ?? "",
    localWorktreeId: raw.labels[MIRROR_LABEL_LOCAL_WORKTREE] ?? "",
    ignoreMode: ignoreModeOf(raw.labels),
    ...(git === undefined ? {} : { git }),
  });
}
