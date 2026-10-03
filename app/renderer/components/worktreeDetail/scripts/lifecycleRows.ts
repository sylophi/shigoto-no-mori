// The Scripts section's lifecycle rows, from the project's config: the
// setup script, the port pool's provision and release, the teardown
// script. Pure, so the section can be drawn without the app.
import type { ScriptSlot } from "@/store/scriptRuns";
import type { ShigomoriConfig } from "@shared/schemas";

type LifecycleScripts = ShigomoriConfig["scripts"];

// A lifecycle script's command, "" when the project has none (or its
// config has not loaded).
export function lifecycleCommand(
  scripts: LifecycleScripts | undefined,
  kind: "setup" | "teardown",
): string {
  return scripts?.[kind]?.trim() ?? "";
}

export interface LifecycleRow {
  slot: ScriptSlot;
  label: string;
  command: string;
}

export function lifecycleRowsOf({
  scripts,
  portPoolActive,
  path,
}: {
  // The project's lifecycle scripts (its config's `scripts`).
  scripts: LifecycleScripts | undefined;
  portPoolActive: boolean;
  // The worktree's path, which the port pool's commands name.
  path: string;
}): LifecycleRow[] {
  const setupCommand = lifecycleCommand(scripts, "setup");
  const teardownCommand = lifecycleCommand(scripts, "teardown");
  const rows: LifecycleRow[] = [];
  if (setupCommand) {
    rows.push({
      slot: { kind: "setup" },
      label: "Setup",
      command: setupCommand,
    });
  }
  if (portPoolActive) {
    const quotedPath = worktreeQuotedPath(path);
    rows.push({
      slot: { kind: "portPool", phase: "provision" },
      label: "Port-pool provision",
      command: `port-pool provision ${quotedPath}`,
    });
    rows.push({
      slot: { kind: "portPool", phase: "release" },
      label: "Port-pool release",
      command: `port-pool release ${quotedPath}`,
    });
  }
  if (teardownCommand) {
    rows.push({
      slot: { kind: "teardown" },
      label: "Teardown",
      command: teardownCommand,
    });
  }
  return rows;
}

function worktreeQuotedPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
