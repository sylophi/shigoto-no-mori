// Each crosses every wire as its tag and fields and decodes back into
// the same class, so callers tell them apart by tag, never by text.
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What a wire sends beside the message, so the far side keys on a code.
export function errorCodeOf(error: unknown): string | undefined {
  return Predicate.hasProperty(error, "code") && typeof error.code === "string"
    ? error.code
    : undefined;
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

// A device's no to this one: a switch on that device (its command
// access, its sharing) that may flip back, not a failure.
export const isPeerRefusal = (error: unknown): boolean =>
  isCommandRefusedError(error) || isNotSharingError(error);

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

// The hub's rate limiter turned a call away (a 429, which the hub's API
// names no error for). `retryAfterSeconds` is the hub's Retry-After,
// which the device list waits out before asking again. Nothing retries
// it sooner, and a write is not replayed.
// Raised by the account service, which no peer-served call reaches, so
// it never crosses a device link to an older build: only the loopback,
// to the terminal's `sm` of the app's own bundle.
export class HubRateLimitedError extends Schema.TaggedError<HubRateLimitedError>()(
  "HubRateLimitedError",
  { retryAfterSeconds: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return this.retryAfterSeconds === undefined
      ? "the hub is rate-limiting this device: try again shortly"
      : `the hub is rate-limiting this device: try again in ${this.retryAfterSeconds} s`;
  }
}

export const isHubRateLimitedError = Schema.is(HubRateLimitedError);

// The hub's refusals of this device (its HTTP API's, hubApi.ts).

export class HubLoginRejectedError extends Schema.TaggedError<HubLoginRejectedError>()(
  "HubLoginRejectedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The device hub did not accept this sign-in.";
  }
}

export class HubCredentialRejectedError extends Schema.TaggedError<HubCredentialRejectedError>()(
  "HubCredentialRejectedError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "The device hub no longer accepts this device's credential.";
  }
}

// The one refusal the app signs out on. The socket's close code only
// reaches a device online at the revoke.
export class HubDeviceRevokedError extends Schema.TaggedError<HubDeviceRevokedError>()(
  "HubDeviceRevokedError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "This device was removed from the account.";
  }
}

// `error` is the sentence a v2 build shows (it knows no tags). A 403,
// which v2 treats as terminal rather than retrying forever.
export class HubUpdateRequiredError extends Schema.TaggedError<HubUpdateRequiredError>()(
  "HubUpdateRequiredError",
  { floor: Schema.Int, error: Schema.String },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return this.error;
  }
}

// Terminal until the account changes: a retry can't succeed.
export const isHubRefusal = Schema.is(
  Schema.Union([
    HubLoginRejectedError,
    HubCredentialRejectedError,
    HubDeviceRevokedError,
    HubUpdateRequiredError,
  ]),
);

export const isHubDeviceRevoked = Schema.is(HubDeviceRevokedError);

// The device hub could not be reached at all: offline, a DNS or TLS
// failure, or a browser hiding a failed response behind CORS.
// `detail` is the transport's own words, for the logs.
export class HubUnreachableError extends Schema.TaggedError<HubUnreachableError>()(
  "HubUnreachableError",
  { detail: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.detail === undefined
      ? "the device hub could not be reached"
      : `the device hub could not be reached: ${this.detail}`;
  }
}

export const isHubUnreachableError = Schema.is(HubUnreachableError);

// gh missing or signed out on the host: every ask answers the same until
// someone installs it or signs in, so nothing asks again on its own.
export class GhUnavailableError extends Schema.TaggedError<GhUnavailableError>()(
  "GhUnavailableError",
  { reason: Schema.Literals(["gh-missing", "gh-signed-out"]) },
) {
  override get message(): string {
    return `gh is not ready: ${this.reason}`;
  }
}

export const isGhUnavailableError = Schema.is(GhUnavailableError);

// A port forward's dial of the host's own port failed (nothing listens
// there, or it never answered): about the port, not the peer or its
// grant.
export class ForwardConnectFailedError extends Schema.TaggedError<ForwardConnectFailedError>()(
  "ForwardConnectFailedError",
  { port: Schema.Int, reason: Schema.String },
) {
  override get message(): string {
    return `nothing answered on port ${this.port} there: ${this.reason}`;
  }
}

export const isForwardConnectFailedError = Schema.is(ForwardConnectFailedError);

// A worktree mid rebase, merge, cherry-pick, revert or bisect: its git
// state is not read until the operation finishes.
export class GitOperationInProgressError extends Schema.TaggedError<GitOperationInProgressError>()(
  "GitOperationInProgressError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `a ${this.operation} is in progress`;
  }
}

export const isGitOperationInProgressError = Schema.is(
  GitOperationInProgressError,
);

// GitHub's hourly limit for unauthenticated calls from this network,
// which a retry's backoff won't outlast.
export class GitHubRateLimitedError extends Schema.TaggedError<GitHubRateLimitedError>()(
  "GitHubRateLimitedError",
  {},
) {
  override get message(): string {
    return "GitHub is rate-limiting requests from this network. Try again later.";
  }
}

export const isGitHubRateLimitedError = Schema.is(GitHubRateLimitedError);

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
  HubRateLimitedError,
  HubUnreachableError,
  // The hub's refusals of this device, which a window words apart
  // (isHubRefusal).
  HubLoginRejectedError,
  HubCredentialRejectedError,
  HubDeviceRevokedError,
  HubUpdateRequiredError,
  GhUnavailableError,
  ForwardConnectFailedError,
  GitOperationInProgressError,
  GitHubRateLimitedError,
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
