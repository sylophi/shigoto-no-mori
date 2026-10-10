import {
  lifecycleSlot,
  type ScriptName,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import { findProject } from "@host/lib/projects";
import {
  attachScript,
  cancelScript,
  listRunningScripts,
  resizeScript,
  startScript,
  writeToScript,
} from "@host/lib/scripts";
import { OrphanSweep } from "@host/lib/scripts/persistence";
import { shellQuote } from "@host/lib/util/shellQuote";
import type { HandlerContext } from "@shared/ipc/transport";
import { prepareScriptRun, scriptEventNotifier } from "../scriptRun";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class UnconfiguredScriptError extends Schema.TaggedError<UnconfiguredScriptError>()(
  "UnconfiguredScriptError",
  { script: Schema.String, project: Schema.String },
) {
  override get message(): string {
    return `No "${this.script}" script configured for ${this.project}`;
  }
}

// The shell command behind each ScriptName.
function resolveScriptCommand(
  script: ScriptName,
  config: ShigomoriConfig | null,
  worktreePath: string,
): string {
  switch (script) {
    case "setup":
      return config?.scripts?.setup?.trim() ?? "";
    case "teardown":
      return config?.scripts?.teardown?.trim() ?? "";
    case "port-pool-provision":
      return `port-pool provision ${shellQuote(worktreePath)}`;
    case "port-pool-release":
      return `port-pool release ${shellQuote(worktreePath)}`;
  }
}

export const scriptsViews: ViewHandlers<
  typeof scriptsContract,
  Views.Services
> = {
  watch: () =>
    Views.view(
      "scripts:watch",
      () => ({ runs: listRunningScripts() }),
      Views.pushed(scriptsContract, "changed"),
    ),
};

export const scriptsHandlers = {
  run: ({ projectId, worktreeId, script }, handlerCtx: HandlerContext) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const ctx = yield* prepareScriptRun(project, worktreeId);
      const command = resolveScriptCommand(
        script,
        ctx.config,
        ctx.worktree.path,
      );
      if (!command) {
        return yield* new UnconfiguredScriptError({
          script,
          project: project.name,
        });
      }
      const runId = yield* startScript({
        command,
        slot: lifecycleSlot(script),
        worktree: ctx.worktree,
        project,
        scriptEnv: ctx.scriptEnv,
        notify: scriptEventNotifier(handlerCtx),
      });
      return { runId };
    }),

  cancel: ({ runId }) =>
    Effect.map(cancelScript(runId), (cancelled) => ({ cancelled })),

  write: async ({ runId, data }) => writeToScript(runId, data),

  resize: async ({ runId, cols, rows }) => resizeScript(runId, cols, rows),

  orphanReport: () => Effect.flatMap(OrphanSweep, (it) => it.takeReport),

  list: async () => ({ runs: listRunningScripts() }),

  attach: async ({ runId }, handlerCtx: HandlerContext) =>
    attachScript(runId, scriptEventNotifier(handlerCtx)),
} satisfies Handlers<typeof scriptsContract, HandlerContext, HostServices>;
