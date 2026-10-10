import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import { findProject } from "@host/lib/projects";
import { startScript } from "@host/lib/scripts";
import {
  readLaunchRow,
  readScriptOrder,
  readScriptSort,
  writeLaunchRowScript,
  writeScriptOrder,
  writeScriptSort,
} from "@host/lib/scripts/packageScriptStats";
import { findWorktreeIdentity } from "@host/lib/git/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Ops from "@host/lib/engineOps";
import { scriptEventNotifier } from "../scriptRun";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class UndefinedScriptError extends Schema.TaggedError<UndefinedScriptError>()(
  "UndefinedScriptError",
  { scriptName: Schema.String },
) {
  override get message(): string {
    return `Script "${this.scriptName}" is not defined in package.json`;
  }
}

export const packageScriptsHandlers = {
  // The worktree's scripts in manifest order (an object
  // keeps that order), the manager the lockfile selects, and each
  // script's use stats. Null when there is no readable package.json.
  list: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const doc = yield* Ops.packageScripts(projectId, worktreeId);
      if (doc === null) return null;
      return {
        scripts: Object.fromEntries(
          doc.scripts.map((script) => [script.name, script.command]),
        ),
        packageManager: doc.packageManager,
        usage: doc.usage,
        launchRow: yield* readLaunchRow(projectId),
      };
    }),

  getSort: ({ projectId, knowsManual }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const mode = yield* readScriptSort(project.id);
      return mode === "manual" && !knowsManual ? "manifest" : mode;
    }),

  setSort: ({ projectId, mode }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      writeScriptSort(project.id, mode),
    ).pipe(Effect.asVoid),

  getOrder: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      readScriptOrder(project.id),
    ),

  setOrder: ({ projectId, arranged }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      writeScriptOrder(project.id, arranged),
    ).pipe(Effect.asVoid),

  setLaunchRow: ({ projectId, scriptName, onRow }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      writeLaunchRowScript(project.id, scriptName, onRow),
    ).pipe(Effect.asVoid),

  run: ({ projectId, worktreeId, scriptName }, handlerCtx) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const [worktree, doc] = yield* Effect.all(
        [
          findWorktreeIdentity(project.id, worktreeId),
          Ops.packageScripts(project.id, worktreeId),
        ],
        { concurrency: 2 },
      );

      // Validated here even though the engine validates again: a missing
      // script should fail this IPC call, not surface as error output in
      // an already-opened console run.
      if (!doc?.scripts.some((script) => script.name === scriptName)) {
        return yield* new UndefinedScriptError({ scriptName });
      }

      // The engine picks the manager and counts the run in the use log;
      // the app's registry spawns the command with the SHIGOMORI_* env.
      const { command, scriptEnv } = yield* Ops.packageScriptLaunch({
        projectId,
        worktreeId,
        scriptName,
      });
      const runId = yield* startScript({
        command,
        slot: { kind: "package", name: scriptName },
        worktree,
        project,
        scriptEnv,
        notify: scriptEventNotifier(handlerCtx),
      });
      return { runId };
    }),
} satisfies EffectHandlers<
  typeof packageScriptsContract,
  HandlerContext,
  HostServices
>;
