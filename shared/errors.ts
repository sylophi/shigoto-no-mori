// The app's typed errors, and the matchers the renderer keys on.
//
// Every error that crosses a wire (Electron IPC, the LAN and direct
// sockets, the hub broker, the control wire) is an Effect tagged error.
// A transport encodes its `_tag` and fields beside the message
// (shared/ipc/wireError.ts), and the far side rebuilds a WireError
// carrying the same tag, so a matcher reads the tag on every wire
// alike. The message stays for display and is built from the fields,
// so wording can change without a matcher following along.
//
// The message-text fallbacks below exist for one reason: a peer on an
// older app version sends message only. The version-skew policy keeps
// both directions working until every device has moved, and the
// fallbacks go when no supported peer version sends message-only
// errors.
import { Schema } from "effect";
import { errorFieldOf, errorMessageOf, errorTagOf } from "./errorOf.ts";

// The class-free readers live in shared/errorOf.ts, effect-free so a
// frame reader need not load effect; re-exported here so callers have
// one module to import. Extension spelled out: scripts/ imports this
// module under plain node, which resolves no extensionless specifier.
export {
  errorCodeOf,
  errorFieldOf,
  errorMessageOf,
  errorTagOf,
} from "./errorOf.ts";

// "Entity gone": a project or worktree was deleted out from under a
// call (worktree delete, project removal, nuke racing a renderer poll).
// The tags are named once here, and the classes and matchers below
// share them: `_tag` is an own property of an instance, not of the
// class, so a matcher cannot read it off the prototype.
export const UNKNOWN_PROJECT_TAG = "UnknownProject";
export const UNKNOWN_WORKTREE_TAG = "UnknownWorktree";
export const NO_DIRECT_CONNECTION_TAG = "NoDirectConnection";
export const BRANCH_NOT_MERGED_TAG = "BranchNotMerged";
export const FORWARD_CONNECT_FAILED_TAG = "ForwardConnectFailed";
export const CHANNEL_OPEN_REFUSED_TAG = "ChannelOpenRefused";
export const PORT_IN_USE_TAG = "PortInUse";
export const PORT_DENIED_TAG = "PortDenied";

export class UnknownProject extends Schema.TaggedError<UnknownProject>()(
  UNKNOWN_PROJECT_TAG,
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Unknown project: ${this.projectId}`;
  }
}

export class UnknownWorktree extends Schema.TaggedError<UnknownWorktree>()(
  UNKNOWN_WORKTREE_TAG,
  { worktreeId: Schema.String },
) {
  override get message(): string {
    return `Unknown worktree: ${this.worktreeId}`;
  }
}

export function unknownProjectError(projectId: string): UnknownProject {
  return new UnknownProject({ projectId });
}

export function unknownWorktreeError(worktreeId: string): UnknownWorktree {
  return new UnknownWorktree({ worktreeId });
}

// Every matcher reads the same way: a tag when the error carries one
// (a typed error, or a wire frame that brought its tag along), else
// the message text an older peer sends. A tag that is there and is
// another error's is a no, whatever the text says.
function taggedMatcher(
  tag: string,
  legacy: (message: string) => boolean,
): (error: unknown) => boolean {
  return (error) => {
    const found = errorTagOf(error);
    if (found !== undefined) return found === tag;
    return legacy(errorMessageOf(error));
  };
}

const ENTITY_GONE_TAGS: ReadonlySet<string> = new Set([
  UNKNOWN_PROJECT_TAG,
  UNKNOWN_WORKTREE_TAG,
]);
const ENTITY_GONE_PREFIXES = ["Unknown project:", "Unknown worktree:"];

export function isEntityGoneError(error: unknown): boolean {
  const tag = errorTagOf(error);
  if (tag !== undefined) return ENTITY_GONE_TAGS.has(tag);
  const message = errorMessageOf(error);
  return ENTITY_GONE_PREFIXES.some((prefix) => message.includes(prefix));
}

// The hub bridge's rejection for a call on a peer it has no direct
// session with (shared/hub/bridgeHandlers.ts requirePeer). The
// renderer keeps a peer's page mounted through a session blip, and
// every query under it then fails this way until the keeper lands the
// session again, which the device registry already shows. So this one
// is not a toast.
export const NO_DIRECT_CONNECTION_PREFIX = "no direct connection to ";

export class NoDirectConnection extends Schema.TaggedError<NoDirectConnection>()(
  NO_DIRECT_CONNECTION_TAG,
  {
    deviceId: Schema.String,
    // Why the keeper has no session right now, when it can say.
    reason: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return (
      `${NO_DIRECT_CONNECTION_PREFIX}${this.deviceId}` +
      (this.reason === null ? "" : ` (${this.reason})`)
    );
  }
}

export const isNoDirectConnectionError = taggedMatcher(
  NO_DIRECT_CONNECTION_TAG,
  (message) => message.startsWith(NO_DIRECT_CONNECTION_PREFIX),
);

// Safe branch delete (`git branch -d`) refused because the branch has
// commits unreachable from other refs. The renderer swaps its confirm
// dialog into a force-delete prompt with friendlier copy than git's
// stderr. The marker is deliberately NOT the phrase git prints ("is
// not fully merged") so the two layers stay distinct:
// host/lib/git/branches.ts detects git's stderr and raises this.
const BRANCH_NOT_MERGED_MARKER = "has unmerged commits";

export class BranchNotMerged extends Schema.TaggedError<BranchNotMerged>()(
  BRANCH_NOT_MERGED_TAG,
  { branch: Schema.String },
) {
  override get message(): string {
    return `Branch '${this.branch}' ${BRANCH_NOT_MERGED_MARKER}.`;
  }
}

export function branchNotMergedError(name: string): BranchNotMerged {
  return new BranchNotMerged({ branch: name });
}

export const isBranchNotMergedError = taggedMatcher(
  BRANCH_NOT_MERGED_TAG,
  (message) => message.includes(BRANCH_NOT_MERGED_MARKER),
);

// A forward:open whose loopback dial on the host failed: nothing
// answered on the port, or it was out of range
// (host/ipc/modules/forward.ts). The one refusal that says something
// about the port rather than the peer or the grant, so the engine's
// start probe (main/core/portForward/engine.ts) lets it through. The
// message keeps the "connect-failed" prefix an older peer sends and
// matches on.
const FORWARD_CONNECT_FAILED_PREFIX = "connect-failed";

export class ForwardConnectFailed extends Schema.TaggedError<ForwardConnectFailed>()(
  FORWARD_CONNECT_FAILED_TAG,
  { detail: Schema.String },
) {
  override get message(): string {
    return `${FORWARD_CONNECT_FAILED_PREFIX}: ${this.detail}`;
  }
}

export const isForwardConnectFailedError = taggedMatcher(
  FORWARD_CONNECT_FAILED_TAG,
  (message) => message.startsWith(FORWARD_CONNECT_FAILED_PREFIX),
);

// A byte-stream open (forward:open, mirror:openStream) the host's
// channel layer refused (host/socket/channelStreams.ts): the
// connection carries no byte channels, the caller's channel id is
// already attached, or the per-connection cap is full. The message is
// the bare reason, which is what an older peer sends as the whole
// message; the reason names live beside the channel layer as
// CHANNEL_OPEN_* in shared/ipc/socket/channels.ts.
export const CHANNEL_OPEN_REFUSED_REASONS = [
  "no-byte-channels",
  "channel-taken",
  "too-many-conns",
] as const;
export type ChannelOpenRefusedReason =
  (typeof CHANNEL_OPEN_REFUSED_REASONS)[number];

export class ChannelOpenRefused extends Schema.TaggedError<ChannelOpenRefused>()(
  CHANNEL_OPEN_REFUSED_TAG,
  { reason: Schema.Literals(CHANNEL_OPEN_REFUSED_REASONS) },
) {
  override get message(): string {
    return this.reason;
  }
}

export function isChannelOpenRefused(
  error: unknown,
  reason: ChannelOpenRefusedReason,
): boolean {
  const tag = errorTagOf(error);
  if (tag !== undefined) {
    return (
      tag === CHANNEL_OPEN_REFUSED_TAG &&
      errorFieldOf(error, "reason") === reason
    );
  }
  return errorMessageOf(error).startsWith(reason);
}

// A forward's local listener could not bind (main/core/portForward/
// engine.ts): the port is taken, or it is privileged. Only these two
// errnos are typed, since a person can act on them; any other bind
// failure passes through as node said it. The messages keep node's
// errno, which is what the fallback below matches in a message from a
// build that passed node's error through untyped.
export class PortInUse extends Schema.TaggedError<PortInUse>()(
  PORT_IN_USE_TAG,
  { port: Schema.Int },
) {
  override get message(): string {
    return `localhost:${this.port} is already in use (EADDRINUSE)`;
  }
}

export class PortDenied extends Schema.TaggedError<PortDenied>()(
  PORT_DENIED_TAG,
  { port: Schema.Int },
) {
  override get message(): string {
    return `localhost:${this.port} needs elevated privileges (EACCES)`;
  }
}

export const isPortInUseError = taggedMatcher(PORT_IN_USE_TAG, (message) =>
  message.includes("EADDRINUSE"),
);

export const isPortDeniedError = taggedMatcher(PORT_DENIED_TAG, (message) =>
  message.includes("EACCES"),
);

// mirror:stop's refusal of a copy it cannot confirm in step with the
// other device (host/ipc/modules/mirror.ts stopMirror, the check
// mirrorStopIsSafe in shared/ipc/modules/mirror.ts): the renderer
// offers discard-and-stop on it, and the control op answers it as its
// own refusal. The message keeps the leading text an older peer sends
// and matches on.
export const MIRROR_STOP_UNCONFIRMED_TAG = "MirrorStopUnconfirmed";
const MIRROR_STOP_UNCONFIRMED_PREFIX =
  "The copy is not confirmed in step with the other device";

export class MirrorStopUnconfirmed extends Schema.TaggedError<MirrorStopUnconfirmed>()(
  MIRROR_STOP_UNCONFIRMED_TAG,
  // The git follower's verdict, "starting" before it has one.
  { status: Schema.String },
) {
  override get message(): string {
    return `${MIRROR_STOP_UNCONFIRMED_PREFIX} (${this.status}), so it may hold commits that exist nowhere else. Resume or reconnect the mirror to let it catch up, or stop it anyway to discard them.`;
  }
}

export const isMirrorStopUnconfirmed = taggedMatcher(
  MIRROR_STOP_UNCONFIRMED_TAG,
  (message) => message.includes(MIRROR_STOP_UNCONFIRMED_PREFIX),
);

// mirror:stop's other failure, raised once the session is already
// gone: the mirror did stop and only the copy's removal failed. Told
// apart so a caller that reports the stop (the CLI's unmirror) does
// not report a failure to stop.
export const MIRROR_COPY_STAYED_TAG = "MirrorCopyStayed";
const MIRROR_COPY_STAYED_PREFIX = "The mirror stopped, but the copy";

export class MirrorCopyStayed extends Schema.TaggedError<MirrorCopyStayed>()(
  MIRROR_COPY_STAYED_TAG,
  {
    // Where the copy is: on the other device (a mirror started to it),
    // or here.
    onPeer: Schema.Boolean,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${MIRROR_COPY_STAYED_PREFIX} ${this.onPeer ? "on the other device" : "here"} stayed: ${this.reason}. Delete it from its page.`;
  }
}

export const isMirrorCopyStayed = taggedMatcher(
  MIRROR_COPY_STAYED_TAG,
  (message) => message.includes(MIRROR_COPY_STAYED_PREFIX),
);

// A worktree delete that refuses outright because the app's registry
// shows scripts running in it (host/ipc/modules/worktrees.ts, the
// refuseRunningScripts flag the transplant's teardown sets). The
// teardown answers it as a kept source rather than a throw, so its
// reader sees the message and the tag beside it (the teardown result's
// sourceError and sourceErrorTag). The message keeps the
// "scripts-running" marker an older peer sends and matches on.
export const SCRIPTS_RUNNING_TAG = "ScriptsRunning";
const SCRIPTS_RUNNING_MARKER = "scripts-running";

export class ScriptsRunning extends Schema.TaggedError<ScriptsRunning>()(
  SCRIPTS_RUNNING_TAG,
  { scriptCount: Schema.Int },
) {
  override get message(): string {
    return `${SCRIPTS_RUNNING_MARKER}: ${this.scriptCount} script(s) are running in this worktree`;
  }
}

// The same reading as taggedMatcher's, for a failure a host already
// turned into an answer: its message, and its tag when it had one.
export function isScriptsRunningReason(
  message: string,
  tag: string | undefined,
): boolean {
  if (tag !== undefined) return tag === SCRIPTS_RUNNING_TAG;
  return message.includes(SCRIPTS_RUNNING_MARKER);
}
