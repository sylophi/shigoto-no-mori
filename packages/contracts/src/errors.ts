// Each crosses every wire as its tag and fields and decodes back into
// the same class, so callers tell them apart by tag, never by text.
import * as Schema from "effect/Schema";

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a wire sends beside the message, so the far side keys on a code.
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export class UnknownProjectError extends Schema.TaggedError<UnknownProjectError>()(
  "UnknownProjectError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Unknown project: ${this.projectId}`;
  }
}

export class UnknownWorktreeError extends Schema.TaggedError<UnknownWorktreeError>()(
  "UnknownWorktreeError",
  { worktreeId: Schema.String },
) {
  override get message(): string {
    return `Unknown worktree: ${this.worktreeId}`;
  }
}

export class UnknownTerminalError extends Schema.TaggedError<UnknownTerminalError>()(
  "UnknownTerminalError",
  { terminalId: Schema.String },
) {
  override get message(): string {
    return "That terminal is closed.";
  }
}

export const isUnknownTerminalError = Schema.is(UnknownTerminalError);

export const isEntityGoneError = Schema.is(
  Schema.Union([UnknownProjectError, UnknownWorktreeError]),
);

// Not a toast: a peer's page stays mounted through a session blip, and
// every query under it fails this way until the keeper redials.
export class NoDirectConnectionError extends Schema.TaggedError<NoDirectConnectionError>()(
  "NoDirectConnectionError",
  { deviceId: Schema.String, reason: Schema.optional(Schema.String) },
) {
  override get message(): string {
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    return `no direct connection to ${this.deviceId}${reason}`;
  }
}

export const isNoDirectConnectionError = Schema.is(NoDirectConnectionError);

// The convert page forces on the next click.
export class ConvertRefusedError extends Schema.TaggedError<ConvertRefusedError>()(
  "ConvertRefusedError",
  { refusal: Schema.Literals(["uncommitted-changes", "status-unreadable"]) },
) {
  override get message(): string {
    return this.refusal === "uncommitted-changes"
      ? "Converting would wipe this worktree's uncommitted changes. Convert again to wipe them."
      : "This worktree's status couldn't be read, so it may hold changes converting would wipe. Convert again to wipe whatever is there.";
  }
}

export const isConvertRefusedError = Schema.is(ConvertRefusedError);

export class WorktreeSettingUpError extends Schema.TaggedError<WorktreeSettingUpError>()(
  "WorktreeSettingUpError",
  {},
) {
  override get message(): string {
    return "This worktree is still being set up. Try again once setup finishes.";
  }
}

export const isWorktreeSettingUpError = Schema.is(WorktreeSettingUpError);

export class BranchNotMergedError extends Schema.TaggedError<BranchNotMergedError>()(
  "BranchNotMergedError",
  { branch: Schema.String },
) {
  override get message(): string {
    return `Branch '${this.branch}' has unmerged commits.`;
  }
}

export const isBranchNotMergedError = Schema.is(BranchNotMergedError);

// The rebase and the merge both stopped and were aborted, so the
// worktree is as it was.
export class SyncConflictsError extends Schema.TaggedError<SyncConflictsError>()(
  "SyncConflictsError",
  { ref: Schema.String },
) {
  override get message(): string {
    return `${this.ref} conflicts with this branch, so nothing changed.`;
  }
}

export const isSyncConflictsError = Schema.is(SyncConflictsError);

export class CommandRefusedError extends Schema.TaggedError<CommandRefusedError>()(
  "CommandRefusedError",
  // The peer that refused, which the asking client fills in: the
  // refusing peer sends none.
  { deviceId: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return "this device is not permitted to run commands on the remote machine";
  }
}

export const isCommandRefusedError = Schema.is(CommandRefusedError);

// A refusal named for the device that refused, where the asker knows it.
export const refusalNamed = <E>(
  error: E,
  deviceId: string,
): E | CommandRefusedError =>
  isCommandRefusedError(error) && error.deviceId === undefined
    ? new CommandRefusedError({ deviceId })
    : error;

export class NotSharingError extends Schema.TaggedError<NotSharingError>()(
  "NotSharingError",
  {},
) {
  override get message(): string {
    return "the remote machine does not share with other devices";
  }
}

export const isNotSharingError = Schema.is(NotSharingError);

// The message is the reason's marker.
export class ChannelRefusedError extends Schema.TaggedError<ChannelRefusedError>()(
  "ChannelRefusedError",
  {
    reason: Schema.Literals([
      "no-byte-channels",
      "channel-taken",
      "too-many-conns",
    ]),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const isChannelRefusedError = Schema.is(ChannelRefusedError);

// Anything no class above names: the far side's message and errno.
export class RemoteCallError extends Schema.TaggedError<RemoteCallError>()(
  "RemoteCallError",
  { text: Schema.String, code: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.text;
  }
}

// Terminal until one of the builds updates.
export class ProtocolVersionMismatchError extends Schema.TaggedError<ProtocolVersionMismatchError>()(
  "ProtocolVersionMismatchError",
  { hostVersion: Schema.Int, clientVersion: Schema.Int },
) {
  override get message(): string {
    return "This device and the other one run versions of Shigoto no Mori that can't talk to each other. Update both to the same version.";
  }
}

export const isProtocolVersionMismatchError = Schema.is(
  ProtocolVersionMismatchError,
);

// Terminal for the dial: a redial with the same ticket gets the same
// answer.
export class LinkRefusedError extends Schema.TaggedError<LinkRefusedError>()(
  "LinkRefusedError",
  {},
) {
  override get message(): string {
    return "the other device refused this connection";
  }
}

export class LinkUnauthenticatedError extends Schema.TaggedError<LinkUnauthenticatedError>()(
  "LinkUnauthenticatedError",
  {},
) {
  override get message(): string {
    return "the device link has not said hello yet";
  }
}

export const ContractErrorSchema = Schema.Union([
  UnknownProjectError,
  UnknownWorktreeError,
  UnknownTerminalError,
  NoDirectConnectionError,
  ConvertRefusedError,
  WorktreeSettingUpError,
  BranchNotMergedError,
  SyncConflictsError,
  CommandRefusedError,
  NotSharingError,
  ProtocolVersionMismatchError,
  LinkRefusedError,
  LinkUnauthenticatedError,
  ChannelRefusedError,
]);

export const isContractError = Schema.is(ContractErrorSchema);

export const CallFailureSchema = Schema.Union([
  ...ContractErrorSchema.members,
  RemoteCallError,
]);

export const isRemoteCallError = Schema.is(RemoteCallError);

export type CallFailure = typeof CallFailureSchema.Type;

export const callFailureOf = (error: unknown): CallFailure =>
  isContractError(error)
    ? error
    : new RemoteCallError({
        text: errorMessageOf(error),
        code: errorCodeOf(error),
      });
