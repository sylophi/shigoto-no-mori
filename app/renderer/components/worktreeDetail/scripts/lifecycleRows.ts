// The Scripts section's lifecycle rows, from the project's config: the
// setup script, the port pool's provision and release, the teardown
// script. Pure, so the section can be drawn without the app.
import type { ScriptSlot } from "@/store/scriptRuns";

export interface LifecycleRow {
  slot: ScriptSlot;
  label: string;
  command: string;
}

export function lifecycleRowsOf({
  setupCommand,
  teardownCommand,
  portPoolActive,
  path,
}: {
  setupCommand: string;
  teardownCommand: string;
  portPoolActive: boolean;
  // The worktree's path, which the port pool's commands name.
  path: string;
}): LifecycleRow[] {
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
