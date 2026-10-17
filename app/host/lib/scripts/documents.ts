// What the Scripts service's areas (../Scripts.ts) share.
import type {
  Project,
  ScriptEvent,
  ScriptRunSlot,
} from "@shigomori/contracts/schemas";
import type { ScriptEnvInput } from "@shigomori/contracts/scriptEnv";
import * as Schema from "effect/Schema";
import type { MarkKind } from "./marks";

// A script that can't start here now, in words for the console.
export class ScriptRefusedError extends Schema.TaggedError<ScriptRefusedError>()(
  "ScriptRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// A delete or move of a worktree something else is already removing or
// moving, in the caller's words.
export class WorktreeBusyError extends Schema.TaggedError<WorktreeBusyError>()(
  "WorktreeBusyError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// The mark a mutation of worktrees runs under (removing.ts): what it
// does to them, and the words it refuses another mutation already under
// way with, or none for a removal that must happen.
export type Mark = {
  readonly kind: MarkKind;
  readonly busy: string | undefined;
};

// Where a run's events go: the calling window's or peer's notifier.
export type NotifyScriptEvent = ((payload: ScriptEvent) => void) & {
  // The connection it delivers to (its handler's signal, one per
  // window generation or peer socket), so a run's stream can tell a
  // connection that already hears it from a new one.
  connection?: AbortSignal;
};

// The SHIGOMORI_* values a run can't derive from the worktree and
// project it is given (the engine's ScriptContext).
export type ScriptEnvValues = Omit<ScriptEnvInput, "worktree" | "project">;

export interface RunArgs {
  readonly command: string;
  // The run's name (SHIGOMORI_SCRIPT_NAME, the logs) is the slot's.
  readonly slot: ScriptRunSlot;
  readonly worktree: {
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly path: string;
  };
  readonly project: Pick<Project, "id" | "path" | "name">;
  // The branch values of the SHIGOMORI_* env contract, for a command
  // that doesn't set that env itself. Absent for `sm run`, which does.
  readonly scriptEnv?: ScriptEnvValues;
  readonly notify: NotifyScriptEvent;
}

// One entry per worktree that has live scripts, with what it takes to
// identify that worktree after its directory is gone.
export interface RunningScriptWorktree {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly worktreeName: string;
  readonly worktreePath: string;
  readonly scriptCount: number;
}
