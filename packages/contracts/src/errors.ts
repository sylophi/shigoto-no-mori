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

// A step that must not take its caller with it: the failure degrades
// to a log line under the given label, the caller carries on.
export async function logFailure(
  label: string,
  run: () => unknown,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn(`${label}: ${errorMessageOf(error)}`);
  }
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

// A peer's command-access gate refused the call: that machine does not
// run commands from here (host/socket/server.ts answers the gated call
// with COMMAND_REFUSED_CODE, and the client transport mints this), as
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

// Every error above, as it crosses a wire.
export const ContractErrorSchema = Schema.Union([
  UnknownProjectError,
  UnknownWorktreeError,
  NoDirectConnectionError,
  ConvertRefusedError,
  WorktreeSettingUpError,
  BranchNotMergedError,
  CommandRefusedError,
]);

const isContractError = Schema.is(ContractErrorSchema);
const encodeContractError = Schema.encodeSync(ContractErrorSchema);
const decodeContractError = Schema.decodeUnknownOption(ContractErrorSchema);

// A failure as a wire carries it: the message every side can show, and
// the encoded error when it is one of the classes above.
export type ErrorWire = { message: string; error?: unknown };

export function errorToWire(error: unknown): ErrorWire {
  const message = errorMessageOf(error);
  return isContractError(error)
    ? { message, error: encodeContractError(error) }
    : { message };
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
