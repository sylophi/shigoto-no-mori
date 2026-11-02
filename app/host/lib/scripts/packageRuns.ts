// A worktree's package scripts (package.json, justfile, Makefile) run in
// its console: the engine picks the tool that runs one (the manager the
// lockfile selects, just or make) and counts the run in the use log, and
// the run is a PTY run like any other.
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import * as EngineScripts from "@shigomori/engine/Scripts";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NotifyScriptEvent } from "./documents";
import type { Runs } from "./runs";

export class UndefinedScriptError extends Schema.TaggedError<UndefinedScriptError>()(
  "UndefinedScriptError",
  { scriptName: Schema.String },
) {
  override get message(): string {
    return `No script named "${this.scriptName}" in this worktree`;
  }
}

export const makePackageRuns = (runs: Runs) =>
  Effect.gen(function* () {
    const scripts = yield* EngineScripts.Scripts;
    const worktrees = yield* Worktrees.Worktrees;

    const startPackage = Effect.fn("Scripts.startPackage")(function* (
      located: Worktrees.Located,
      scriptName: string,
      notify: NotifyScriptEvent,
    ) {
      // Checked here though the engine checks again: a missing script
      // fails the call rather than show as error output in a console
      // run already open.
      const listed = yield* scripts
        .list({
          projectId: located.project.id,
          worktreePath: located.worktree.path,
        })
        .pipe(
          Effect.catchTag(["NoScripts", "UnreadableScripts"], () =>
            Effect.succeed(null),
          ),
        );
      if (!listed?.scripts.some((script) => script.name === scriptName)) {
        return yield* new UndefinedScriptError({ scriptName });
      }
      const { program, args } = yield* scripts.command({
        worktree: located.worktree,
        script: scriptName,
        extra: [],
      });
      const context = yield* worktrees.scriptContext(located);
      yield* scripts.recordRun(located.project.id, scriptName);
      return yield* runs.start({
        command: [program, ...args].map(shellQuote).join(" "),
        slot: { kind: "package", name: scriptName },
        worktree: located.worktree,
        project: located.project,
        scriptEnv: {
          projectBranch: context.projectBranch,
          defaultBranch: context.defaultBranch,
          title: context.title,
          description: context.description,
        },
        notify,
      });
    });

    return { startPackage };
  });
