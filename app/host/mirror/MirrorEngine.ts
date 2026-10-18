// The mirror daemon as the mirror surfaces use it (registry.ts,
// sessions.ts, the handlers), with the git follower and the threads
// over it (MirrorEngineLayer.ts).
import type {
  MirrorDaemonStatus,
  MirrorEvent,
  MirrorEventKind,
  MirrorGitStatus,
  MirrorSessionRaw,
} from "@shigomori/contracts/modules/mirror";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The create request the daemon takes (file-sync/engine.go
// mirrorRequest, the create fields).
export type MirrorCreateInput = {
  localRoot: string;
  deviceId: string;
  projectId: string;
  worktreeId: string;
  remoteRoot: string;
  name: string;
  // This device's own worktree id, carried to the peer in the stream
  // preface so its sidebar can fold the pair. A field of its own, not
  // a label the engine would have to know the key of.
  localWorktreeId: string;
  labels: Record<string, string>;
  ignores: readonly string[];
  // A pull (file-sync/engine.go mirrorRequest.pull): files flow one
  // way, remote to local, and nothing here reaches the peer. The
  // transplant's one-shot transfer. Absent, a two-way mirror.
  pull?: boolean;
  // A push (mirrorRequest.push), the pull turned around: local to
  // remote, and nothing the peer holds lands here. A sent worktree's
  // one-shot transfer.
  push?: boolean;
  // A replica (mirrorRequest.replica): local to remote, the remote
  // made an exact copy. A mirror start's first pass.
  replica?: boolean;
};

// What a mirror operation refused, in words for the user.
export class MirrorError extends Schema.TaggedError<MirrorError>()(
  "MirrorError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class MirrorEngine extends Context.Service<
  MirrorEngine,
  {
    readonly status: Effect.Effect<MirrorDaemonStatus>;
    // Why a "failing" engine last stopped or couldn't start.
    readonly failure: Effect.Effect<string | undefined>;
    readonly sessions: Effect.Effect<readonly MirrorSessionRaw[]>;
    // Whether `sessions` is the running daemon's own (MirrorDaemon.ts).
    readonly fresh: Effect.Effect<boolean>;
    readonly create: (
      input: MirrorCreateInput,
    ) => Effect.Effect<string, MirrorError>;
    // Opens a fresh session in place of one, whatever hangs off the old
    // id (the git follower's agreement) carried across. The old one is
    // paused while the new one is made, resumed if that fails, and
    // ended once it is up.
    readonly recreate: (
      session: string,
      input: MirrorCreateInput,
    ) => Effect.Effect<string, MirrorError>;
    readonly terminate: (session: string) => Effect.Effect<void, MirrorError>;
    readonly pause: (session: string) => Effect.Effect<void, MirrorError>;
    readonly resume: (session: string) => Effect.Effect<void, MirrorError>;
    // The git follower's verdict for a session (host/mirror/gitFollow.ts).
    readonly gitStatus: (session: string) => MirrorGitStatus | undefined;
    // The verdict looked at again now, for a decision that must not
    // read a cached one (the stop's safety check).
    readonly refreshGit: (
      session: string,
    ) => Effect.Effect<MirrorGitStatus | undefined>;
    // The mirror's thread of events, by local worktree (host/mirror/
    // history.ts), and the way a control op adds to it.
    readonly history: (localWorktreeId: string) => readonly MirrorEvent[];
    readonly noteEvent: (
      localWorktreeId: string,
      kind: MirrorEventKind,
      detail: string,
    ) => void;
    // Tells the copy's device a session's copy is no longer mirrored, so
    // the invitation it left for this device (host/mirror/invites.ts)
    // goes and the copy is an ordinary worktree there. Best effort and in
    // the engine's background: a peer away, or on a build without the
    // verb, keeps the invitation until the copy is deleted, which only
    // ever admits this device's calls on that copy.
    readonly releaseCopy: (raw: MirrorSessionRaw) => Effect.Effect<void>;
    // Drops a worktree's thread, once the worktree itself is gone.
    readonly forgetHistory: (localWorktreeId: string) => void;
    // Moves a worktree's thread to the id it has after a move.
    readonly moveHistory: (from: string, to: string) => void;
    // A project's git state moved here, or on a peer, or a worktree a
    // peer serves: the git follower looks at the sessions it touches.
    readonly localProjectChanged: (projectId: string) => void;
    readonly peerProjectChanged: (deviceId: string, projectId: string) => void;
    readonly peerWorktreeChanged: (
      deviceId: string,
      projectId: string,
      worktreeId: string,
    ) => void;
    // This device left its account: every mirror and transfer ends,
    // copies kept, for as long as the sweep's bound allows.
    readonly leaveAccount: Effect.Effect<void>;
  }
>()("sm/host/MirrorEngine") {}
