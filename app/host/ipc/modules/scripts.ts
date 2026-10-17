import {
  lifecycleSlot,
  type ScriptName,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/Views";
import { findProject } from "@host/lib/projects";
import * as Scripts from "@host/lib/Scripts";
import * as OrphanSweep from "@host/lib/scripts/OrphanSweep";
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

const listed = Effect.map(Scripts.Scripts, (scripts) => ({
  runs: scripts.list(),
}));

export const scriptsViews: ViewHandlers<
  typeof scriptsContract,
  Views.Services | Scripts.Scripts
> = {
  watch: () =>
    Views.view(
      "scripts:watch",
      () => listed,
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
      const runId = yield* (yield* Scripts.Scripts).start({
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
    Effect.flatMap(Scripts.Scripts, (scripts) =>
      Effect.map(scripts.cancel(runId), (cancelled) => ({ cancelled })),
    ),

  write: ({ runId, data }) =>
    Effect.map(Scripts.Scripts, (scripts) => scripts.write(runId, data)),

  resize: ({ runId, cols, rows }) =>
    Effect.map(Scripts.Scripts, (scripts) => scripts.resize(runId, cols, rows)),

  orphanReport: () =>
    Effect.flatMap(OrphanSweep.OrphanSweep, (sweep) => sweep.takeReport),

  list: () => listed,

  attach: ({ runId }, handlerCtx: HandlerContext) =>
    Effect.map(Scripts.Scripts, (scripts) =>
      scripts.attach(runId, scriptEventNotifier(handlerCtx)),
    ),
} satisfies EffectHandlers<
  typeof scriptsContract,
  HandlerContext,
  HostServices
>;
