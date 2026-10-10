import type { Migration } from "@shigomori/contracts/schemas/migration";

const ended = (step: { readonly state: string } | null) =>
  step === null || step.state === "done" || step.state === "stuck";

// Every step has ended, and whether one is stuck.
export function migrationEnded(migration: Migration) {
  const steps = [migration.import, migration.worktrees, migration.signIn];
  return {
    ended: migration.planned && steps.every(ended),
    stuck: steps.some((step) => step?.state === "stuck"),
  };
}
