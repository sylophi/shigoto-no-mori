// The failures a caller branches on, as tagged error classes. Each one
// crosses every wire as its tag and fields (errorToWire, errorFromWire)
// and decodes back into the same class on the other side, so the
// renderer tells them apart with the predicates below, never by their
// text. The messages are the user-facing words, built from the fields.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The machine-readable code an error carries, when it has one (a
// ControlError, a Node errno). What a wire sends beside the message so
// the far side keys on the code and not on the prose.
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

// A project or worktree deleted out from under a call (worktree delete,
// project removal, nuke racing a renderer poll).
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

export const isEntityGoneError = Schema.is(
  Schema.Union([UnknownProjectError, UnknownWorktreeError]),
);

// The hub bridge's rejection for a call on a peer it has no direct
// session with (shared/hub/bridgeHandlers.ts requirePeer), with the
// keeper's reason when it has one. The renderer keeps a peer's page
// mounted through a session blip, and every query under it then fails
// this way until the keeper lands the session again, which the device
// registry already shows. So this one is not a toast.
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

// An unforced convert that `sm adopt`'s guard refused: uncommitted
// changes (untracked files included) or a status it couldn't read. The
// host builds it from the run's --json code (host/ipc/cliDelegate.ts
// guardRefusal) in the page's words, not the CLI's, and the convert
// page forces on the next click.
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

// A delete or move refused because the worktree's create run
// (carry-over, setup, port provision) is still working in it. The
// detail page reports it instead of offering a force delete, which the
// host would refuse the same way.
export class WorktreeSettingUpError extends Schema.TaggedError<WorktreeSettingUpError>()(
  "WorktreeSettingUpError",
  {},
) {
  override get message(): string {
    return "This worktree is still being set up. Try again once setup finishes.";
  }
}

export const isWorktreeSettingUpError = Schema.is(WorktreeSettingUpError);

// Safe branch delete (`git branch -d`) refused because the branch has
// commits unreachable from other refs. The renderer swaps its confirm
// dialog into a force-delete prompt with friendlier copy than git's
// stderr, which host/lib/git/branches.ts detects and rethrows as this.
export class BranchNotMergedError extends Schema.TaggedError<BranchNotMergedError>()(
  "BranchNotMergedError",
  { branch: Schema.String },
) {
  override get message(): string {
    return `Branch '${this.branch}' has unmerged commits.`;
  }
}

export const isBranchNotMergedError = Schema.is(BranchNotMergedError);

// "Sync from primary" refused because the primary branch conflicts with
// this one: the rebase and the merge both stopped and were aborted, so
// the worktree is as it was. The pill offers to merge anyway and leave
// the conflicts to resolve.
export class SyncConflictsError extends Schema.TaggedError<SyncConflictsError>()(
  "SyncConflictsError",
  { ref: Schema.String },
) {
  override get message(): string {
    return `${this.ref} conflicts with this branch, so nothing changed.`;
  }
}

export const isSyncConflictsError = Schema.is(SyncConflictsError);

// A peer's command-access gate refused the call: that machine does not
// run commands from here (host/socket/server.ts's dispatch gate), as
// distinct from a real handler failure.
export class CommandRefusedError extends Schema.TaggedError<CommandRefusedError>()(
  "CommandRefusedError",
  {},
) {
  override get message(): string {
    return "this device is not permitted to run commands on the remote machine";
  }
}

export const isCommandRefusedError = Schema.is(CommandRefusedError);

// The far side failed the call with something no class above names.
// Its message is the far side's own words (a refusal marker some
// callers match, see channelRefusals.ts), and its code the errno or
// marker it carried, so errorMessageOf and errorCodeOf read it like the
// error it was.
export class RemoteCallError extends Schema.TaggedError<RemoteCallError>()(
  "RemoteCallError",
  { text: Schema.String, code: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.text;
  }
}

// The device link's handshake (modules/link.ts): the two builds speak
// different protocol versions (protocol.ts), so neither can read the
// other. Terminal until one of them updates, and the peer's page says
// so in these words.
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

// The handshake's refusal: the hello proved no ticket this host minted
// for that device, or came after the connection's one hello. Terminal
// for the dial: a redial with the same ticket cannot change the answer.
export class LinkRefusedError extends Schema.TaggedError<LinkRefusedError>()(
  "LinkRefusedError",
  {},
) {
  override get message(): string {
    return "the other device refused this connection";
  }
}

// A call on a device link before its hello was accepted.
export class LinkUnauthenticatedError extends Schema.TaggedError<LinkUnauthenticatedError>()(
  "LinkUnauthenticatedError",
  {},
) {
  override get message(): string {
    return "the device link has not said hello yet";
  }
}

// Every error above, as it crosses a wire.
export const ContractErrorSchema = Schema.Union([
  UnknownProjectError,
  UnknownWorktreeError,
  NoDirectConnectionError,
  ConvertRefusedError,
  WorktreeSettingUpError,
  BranchNotMergedError,
  SyncConflictsError,
  CommandRefusedError,
  ProtocolVersionMismatchError,
  LinkRefusedError,
  LinkUnauthenticatedError,
]);

export const isContractError = Schema.is(ContractErrorSchema);

// How a call fails on the device link: as one of the errors above, or
// as RemoteCallError, which carries any other failure's message and
// code.
export const CallFailureSchema = Schema.Union([
  ...ContractErrorSchema.members,
  RemoteCallError,
]);

export const isRemoteCallError = Schema.is(RemoteCallError);

const encodeContractError = Schema.encodeUnknownOption(ContractErrorSchema);
const decodeContractError = Schema.decodeUnknownOption(ContractErrorSchema);

// A failure as a wire carries it: the message every side can show, and
// the encoded error when it is one of the classes above.
export type ErrorWire = { message: string; error?: unknown };

export function errorToWire(error: unknown): ErrorWire {
  const message = errorMessageOf(error);
  return Option.match(encodeContractError(error), {
    onNone: () => ({ message }),
    onSome: (encoded) => ({ message, error: encoded }),
  });
}

// The failure back from its wire form: the class it was sent as, or a
// plain Error with its message for anything else (or an error this
// build does not know).
export function errorFromWire(wire: ErrorWire): Error {
  return Option.getOrElse(
    decodeContractError(wire.error),
    () => new Error(wire.message),
  );
}
