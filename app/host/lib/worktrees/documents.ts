// What the Worktrees service's moves and removals (../Worktrees.ts)
// share.
import * as Schema from "effect/Schema";

const counted = (n: number, noun: string) =>
  n === 0 ? [] : [`${n} ${noun}${n === 1 ? "" : "s"}`];

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
