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
import { errorMessageOf, errorTagOf } from "./errorOf.ts";

// The class-free readers live in shared/errorOf.ts (the hub Worker
// compiles the frame schemas that need them and must not load
// effect); re-exported here so callers have one module to import.
// Extension spelled out: scripts/ imports this module under plain
// node, which resolves no extensionless specifier.
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

export function isNoDirectConnectionError(error: unknown): boolean {
  const tag = errorTagOf(error);
  if (tag !== undefined) return tag === NO_DIRECT_CONNECTION_TAG;
  return errorMessageOf(error).startsWith(NO_DIRECT_CONNECTION_PREFIX);
}

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

export function isBranchNotMergedError(error: unknown): boolean {
  const tag = errorTagOf(error);
  if (tag !== undefined) return tag === BRANCH_NOT_MERGED_TAG;
  return errorMessageOf(error).includes(BRANCH_NOT_MERGED_MARKER);
}
