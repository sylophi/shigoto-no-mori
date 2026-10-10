import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import type { StepState } from "./StepsPageView.tsx";

// The sign-in's step: its state, and whether it waits on the person (a
// lapsed session) or goes by itself.
export type SignInStep = { readonly state: StepState; readonly asks: boolean };

const ended = (step: { readonly state: string } | null) =>
  step === null || step.state === "done" || step.state === "stuck";

// Whether the app opens by itself (every step done), or a Continue
// takes the person on: past a stuck step, or past a sign-in they can
// make later, once nothing else is running.
export function migrationEnded(
  migration: MigrationProgress,
  signIn: SignInStep | null,
) {
  const steps = [migration.import, migration.worktrees, signIn];
  const settled =
    migration.planned &&
    [migration.import, migration.worktrees].every(ended) &&
    (ended(signIn) || signIn?.asks === true);
  return {
    open:
      settled && steps.every((step) => step === null || step.state === "done"),
    canContinue:
      settled && !steps.every((step) => step === null || step.state === "done"),
  };
}
