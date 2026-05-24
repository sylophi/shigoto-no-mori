// Single source of truth for the shell command behind each ScriptName.
// Used by both the on-demand IPC entry point and the create/delete
// lifecycle orchestrator so the two paths can never drift.
import type { ScriptName, ShigomoriConfig } from "@shared/schemas";
import { shellQuote } from "./packageScripts";

export function resolveScriptCommand(
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
