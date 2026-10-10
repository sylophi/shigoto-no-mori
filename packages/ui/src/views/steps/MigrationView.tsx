// The v3 migration, on the page a window shows in place of the app
// while it runs: the store's import, the move into `wt/` with its count
// and the worktree on the move, and this device's sign-in for its key,
// a button only once its session has lapsed. With every step done the
// app opens by itself; past a stuck step or a sign-in left for later,
// Continue opens it.
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import { migrationEnded, type SignInStep } from "./migrationEnded.ts";
import {
  SignInStepView,
  StepActionView,
  StepCountView,
  StepProgressView,
  StepRowView,
  StepsPageView,
  StepStuckView,
} from "./StepsPageView.tsx";

export function MigrationView({
  migration,
  signIn,
  onSignIn,
  onContinue,
}: {
  migration: MigrationProgress;
  // The device key's enrollment, while it is due.
  signIn: SignInStep | null;
  onSignIn: () => void;
  onContinue: () => void;
}) {
  const { import: imported, worktrees } = migration;
  const { canContinue } = migrationEnded(migration, signIn);
  return (
    <StepsPageView
      title="Moving to 3.0"
      footer={
        canContinue ? (
          <StepActionView label="Continue" onClick={onContinue} />
        ) : undefined
      }
    >
      {imported !== null && (
        <StepRowView label="Projects and settings" state={imported.state} />
      )}
      {worktrees !== null && (
        <StepRowView
          label="Worktrees"
          state={worktrees.state}
          trailing={
            worktrees.total > 0 && (
              <StepCountView done={worktrees.moved} total={worktrees.total} />
            )
          }
        >
          {worktrees.state === "running" && worktrees.total > 0 && (
            <StepProgressView
              done={worktrees.moved + worktrees.stuck.length}
              total={worktrees.total}
              current={worktrees.current}
            />
          )}
          {worktrees.stuck.length > 0 && (
            <StepStuckView items={worktrees.stuck} />
          )}
        </StepRowView>
      )}
      {signIn !== null && (
        <SignInStepView
          state={signIn.state}
          asks={signIn.asks}
          onSignIn={onSignIn}
        />
      )}
    </StepsPageView>
  );
}
