// What the Worktrees service's areas (../Worktrees.ts) share.
import { pluralize } from "@shigomori/contracts/words";
import {
  type ScriptEvent,
  ScriptEventSchema,
} from "@shigomori/contracts/schemas";
import type * as EngineWorktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scripts from "../Scripts";

const counted = (n: number, noun: string) =>
  n === 0 ? [] : [pluralize(n, noun)];

// The scripts and terminals running in a worktree hold its folder.
export class RunningWorkError extends Schema.TaggedError<RunningWorkError>()(
  "RunningWorkError",
  {
    verb: Schema.Literals(["move", "rename"]),
    name: Schema.String,
    scripts: Schema.Natural,
    terminals: Schema.Natural,
  },
) {
  override get message(): string {
    const running = [
      ...counted(this.scripts, "script"),
      ...counted(this.terminals, "terminal"),
    ];
    const one = this.scripts + this.terminals === 1;
    return `Can't ${this.verb} ${this.name} while ${running.join(" and ")} ${one ? "is" : "are"} running there. Stop ${one ? "it" : "them"} first.`;
  }
}

// The transplant's teardown refused: scripts run in the worktree.
// "scripts-running" is a marker the transplant and the renderer match
// on, not prose.
export class ScriptsRunningError extends Schema.TaggedError<ScriptsRunningError>()(
  "ScriptsRunningError",
  { scripts: Schema.Natural },
) {
  override get message(): string {
    return `scripts-running: ${this.scripts} script(s) are running in this worktree`;
  }
}

const decodeScriptEvent = Schema.decodeUnknownSync(ScriptEventSchema);

// A "script" event of an engine run, as the script event it carries (the
// event tag itself is the reporter's, not the payload's).
export function scriptEventOf(
  event: Extract<EngineWorktrees.WorktreeEvent, { event: "script" }>,
): ScriptEvent {
  const { event: _event, ...scriptEvent } = event;
  return decodeScriptEvent(scriptEvent);
}

// `use` given a reporter that books the lifecycle scripts an engine run
// reports (Scripts.lifecycleRuns), their events to `notify`, and
// forwards nothing else.
export const bookingScripts = <A, E, R>(
  scripts: Scripts.Scripts["Service"],
  notify: Scripts.NotifyScriptEvent,
  use: (reporter: EngineWorktrees.Reporter) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    scripts.lifecycleRuns(notify),
    (runs) =>
      use({
        report: (event) =>
          Effect.sync(() => {
            if (event.event === "script") runs.forward(scriptEventOf(event));
          }),
        color: true,
      }),
    (runs) => Effect.sync(runs.end),
  );
