import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";

const ended = (step: { readonly state: string } | null) =>
  step === null || step.state === "done" || step.state === "stuck";

// Whether the app opens by itself (every step done), or a Continue
// takes the person on past a stuck step, once nothing else is running.
export function migrationEnded(migration: MigrationProgress) {
  const steps = [migration.import, migration.worktrees];
  const settled = migration.planned && steps.every(ended);
  const done = steps.every((step) => step === null || step.state === "done");
  return { open: settled && done, canContinue: settled && !done };
}
