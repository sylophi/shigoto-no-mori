// The v3 migration, on the page a window shows in place of the app
// while it runs: the store's import, the move into `wt/` with its count
// and the worktree on the move. A stuck move can be tried again once
// what held it is closed, and says when a retry left it stuck. With
// every step done the app opens by itself. Past a stuck step, Continue
// opens it.
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import { migrationEnded } from "./migrationEnded.ts";
import {
  StepActionView,
  StepCountView,
  StepProgressView,
  StepReasonView,
  StepRowView,
  StepsPageView,
  StepStuckView,
} from "./StepsPageView.tsx";

export function MigrationView({
  migration,
  onContinue,
  onRetry,
  retrying,
  retried,
}: {
  migration: MigrationProgress;
  onContinue: () => void;
  // The stuck import or moves tried again, and whether that is under
  // way.
  onRetry: () => void;
  retrying: boolean;
  // Whether a retry has run, so a move still stuck says so.
  retried: boolean;
}) {
  const { import: imported, worktrees } = migration;
  const { canContinue } = migrationEnded(migration);
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
        <StepRowView label="Projects and settings" state={imported.state}>
          {imported.state === "stuck" && (
            <>
              {imported.reason !== undefined && (
                <StepReasonView text={imported.reason} />
              )}
              <div className="flex items-center justify-end">
                <StepActionView
                  label="Retry"
                  variant="outline"
                  pending={retrying}
                  onClick={onRetry}
                />
              </div>
            </>
          )}
        </StepRowView>
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
          {worktrees.state === "stuck" && (
            <div className="flex items-center justify-end gap-3">
              {retried && (
                <span className="text-xs text-muted-foreground">
                  Still stuck after the retry.
                </span>
              )}
              <StepActionView
                label="Retry"
                variant="outline"
                pending={retrying}
                onClick={onRetry}
              />
            </div>
          )}
        </StepRowView>
      )}
    </StepsPageView>
  );
}
