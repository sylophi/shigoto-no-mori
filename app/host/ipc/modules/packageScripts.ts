import { packageScriptsContract } from "@shigomori/contracts/modules/packageScripts";
import type { Handlers } from "@shigomori/contracts/types";
import { findProjectOrThrow } from "@host/lib/projects";
import { startScript } from "@host/lib/scripts";
import {
  readLaunchRow,
  readScriptOrder,
  readScriptSort,
  writeLaunchRowScript,
  writeScriptOrder,
  writeScriptSort,
} from "@host/lib/scripts/packageScriptStats";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import type { HandlerContext } from "@shared/ipc/transport";
import { packageScriptLaunch, packageScripts } from "@host/lib/engineCalls";
import { scriptEventNotifier } from "../scriptRun";
import type { HostServices } from "@host/process/services";
import { fromPromise } from "@host/lib/util/fromPromise";
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
  list: async ({ projectId, worktreeId }) => {
    const doc = await packageScripts(projectId, worktreeId);
    if (doc === null) return null;
    return {
      scripts: Object.fromEntries(
        doc.scripts.map((script) => [script.name, script.command]),
      ),
      packageManager: doc.packageManager,
      usage: doc.usage,
      launchRow: await readLaunchRow(projectId),
    };
  },

  getSort: async ({ projectId, knowsManual }) => {
    const project = await findProjectOrThrow(projectId);
    const mode = await readScriptSort(project.id);
    return mode === "manual" && !knowsManual ? "manifest" : mode;
  },

  setSort: async ({ projectId, mode }) => {
    const project = await findProjectOrThrow(projectId);
    await writeScriptSort(project.id, mode);
  },

  getOrder: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return readScriptOrder(project.id);
  },

  setOrder: async ({ projectId, arranged }) => {
    const project = await findProjectOrThrow(projectId);
    await writeScriptOrder(project.id, arranged);
  },

  setLaunchRow: async ({ projectId, scriptName, onRow }) => {
    const project = await findProjectOrThrow(projectId);
    await writeLaunchRowScript(project.id, scriptName, onRow);
  },

  run: ({ projectId, worktreeId, scriptName }, handlerCtx) =>
    Effect.gen(function* () {
      const project = yield* fromPromise(() => findProjectOrThrow(projectId));
      const [worktree, doc] = yield* fromPromise(() =>
        Promise.all([
          findWorktreeIdentityOrThrow(project.id, worktreeId),
          packageScripts(project.id, worktreeId),
        ]),
      );

      // Validated here even though the engine validates again: a missing
      // script should fail this IPC call, not surface as error output in
      // an already-opened console run.
      if (!doc?.scripts.some((script) => script.name === scriptName)) {
        return yield* new UndefinedScriptError({ scriptName });
      }

      // The engine picks the manager and counts the run in the use log;
      // the app's registry spawns the command with the SHIGOMORI_* env.
      const { command, scriptEnv } = yield* fromPromise(() =>
        packageScriptLaunch({ projectId, worktreeId, scriptName }),
      );
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
} satisfies Handlers<
  typeof packageScriptsContract,
  HandlerContext,
  HostServices
>;
