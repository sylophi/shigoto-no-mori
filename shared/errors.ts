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
import { errorMessageOf, errorTagOf } from "./errorOf";

// The class-free readers live in shared/errorOf.ts (the hub Worker
// compiles the frame schemas that need them and must not load
// effect); re-exported here so callers have one module to import.
export {
  errorCodeOf,
  errorFieldOf,
  errorMessageOf,
  errorTagOf,
} from "./errorOf";

// "Entity gone": a project or worktree was deleted out from under a
// call (worktree delete, project removal, nuke racing a renderer poll).
export class UnknownProject extends Schema.TaggedError<UnknownProject>()(
  "UnknownProject",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Unknown project: ${this.projectId}`;
  }
}

export class UnknownWorktree extends Schema.TaggedError<UnknownWorktree>()(
  "UnknownWorktree",
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
  UnknownProject.prototype._tag,
  UnknownWorktree.prototype._tag,
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
  "NoDirectConnection",
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
  if (tag !== undefined) return tag === NoDirectConnection.prototype._tag;
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
  "BranchNotMerged",
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
  if (tag !== undefined) return tag === BranchNotMerged.prototype._tag;
  return errorMessageOf(error).includes(BRANCH_NOT_MERGED_MARKER);
}
