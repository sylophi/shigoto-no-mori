// The v3 migration, on the page a window shows in place of the app
// while it runs: the store's import, the move into `wt/` with its count
// and the worktree on the move, and this device's sign-in, a button
// only once its session has lapsed. Continue ends it past a stuck step;
// with nothing stuck the app opens by itself.
import type { Migration } from "@shigomori/contracts/schemas/migration";
import { migrationEnded } from "./migrationEnded.ts";
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
  signingIn,
  onSignIn,
  onContinue,
}: {
  migration: Migration;
  signingIn: boolean;
  onSignIn: () => void;
  onContinue: () => void;
}) {
  const { import: imported, worktrees, signIn } = migration;
  const { ended, stuck } = migrationEnded(migration);
  return (
    <StepsPageView
      title="Moving to 3.0"
      footer={
        ended && stuck ? (
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
          state={signingIn ? "running" : signIn.state}
          asks={signIn.lapsed && signIn.state !== "done"}
          onSignIn={onSignIn}
        />
      )}
    </StepsPageView>
  );
}
