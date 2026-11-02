import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { findProject, findWorktreeIdentity } from "@host/lib/projects";
import * as Scripts from "@host/lib/Scripts";
import type { HandlerContext } from "@shared/ipc/transport";
import type {
  PackageScriptSortMode,
  PackageScriptsDoc,
  ScriptGroup,
} from "@shigomori/contracts/schemas";
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
    return `No script named "${this.scriptName}" in this worktree`;
  }
}

export const packageScriptsHandlers = {
  // The worktree's scripts in file order (an object keeps that order),
  // grouped by the file they come from, the manager the lockfile
  // selects, and each script's use stats. Null when there is no
  // package.json, justfile or Makefile, or none of them reads.
  list: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const doc = yield* Ops.packageScripts(projectId, worktreeId);
      if (doc === null) return null;
      return {
        scripts: Object.fromEntries(
          doc.scripts.map((script) => [script.name, script.command]),
        ),
        packageManager: doc.packageManager,
        groups: groupByFile(doc.scripts),
        usage: doc.usage,
        // The scripts put on the launch row by hand, which the row limits
        // itself to under the "manual" sort. Project-wide like the order,
        // so it can name scripts a given worktree lacks.
        launchRow: yield* Ops.onScripts((scripts) =>
          scripts.launchRow(projectId),
        ),
      };
    }),

  getSort: ({ projectId, knowsManual }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const { sort } = yield* Ops.onScripts((scripts) =>
        scripts.arrangement(project.id),
      );
      const mode = sort as PackageScriptSortMode;
      return mode === "manual" && !knowsManual ? "manifest" : mode;
    }),

  // "frequent" is the implicit default: switching back to it deletes
  // the stored entry instead of writing it.
  setSort: ({ projectId, mode }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.onScripts((scripts) => scripts.setSort(project.id, mode)),
    ).pipe(Effect.asVoid),

  getOrder: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.onScripts((scripts) =>
        Effect.map(scripts.arrangement(project.id), ({ order }) => [...order]),
      ),
    ),

  // `arranged` is one worktree's scripts in their new order, merged
  // against the stored order rather than by the client against its
  // cached copy, which another window may have written past.
  setOrder: ({ projectId, arranged }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.onScripts((scripts) => scripts.arrange(project.id, arranged)),
    ).pipe(Effect.asVoid),

  // One script on or off the row, applied against the stored row rather
  // than as a whole list from the client, so two windows picking
  // different scripts both land.
  setLaunchRow: ({ projectId, scriptName, onRow }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      Ops.onScripts((scripts) =>
        scripts.setOnLaunchRow(project.id, scriptName, onRow),
      ),
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
      const runId = yield* (yield* Scripts.Scripts).start({
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

function groupByFile(
  scripts: PackageScriptsDoc["scripts"],
): ReadonlyArray<ScriptGroup> {
  // Maps, not object keys, so a script named "__proto__" is a script.
  const groups = new Map<string, Map<string, string>>();
  for (const script of scripts) {
    const labels = groups.get(script.file) ?? new Map<string, string>();
    labels.set(script.name, script.label);
    groups.set(script.file, labels);
  }
  return [...groups].map(([file, labels]) => ({
    file,
    labels: Object.fromEntries(labels),
  }));
}
