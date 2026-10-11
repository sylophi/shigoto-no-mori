// The mirror daemon as the mirror surfaces use it (registry.ts,
// sessions.ts, the handlers), which the root provides from the daemon
// service, the git follower and the threads (host/process/handlers.ts).
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
    readonly sessions: Effect.Effect<readonly MirrorSessionRaw[]>;
    readonly create: (
      input: MirrorCreateInput,
    ) => Effect.Effect<string, MirrorError>;
    // Ends a session and opens a fresh one in its place, whatever hangs
    // off the old id (the git follower's agreement) carried across.
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
    // Drops a worktree's thread, once the worktree itself is gone.
    readonly forgetHistory: (localWorktreeId: string) => void;
    // Moves a worktree's thread to the id it has after a move.
    readonly moveHistory: (from: string, to: string) => void;
  }
>()("sm/host/MirrorEngine") {}
