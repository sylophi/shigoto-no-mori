// The page a window shows in place of the app while it gets ready: the
// v3 migration in each of its states (its import under way or stuck,
// the worktrees on the move, a locked one stuck, a lapsed session's
// sign-in, every step done).
import { MigrationView } from "../views/steps/MigrationView.tsx";
import {
  MIGRATION_POSES,
  type MigrationPose,
} from "../fixtures/stepsFixtures.ts";
import { SceneWindowFrame } from "./frame.tsx";

const noop = () => {};

function migration(pose: MigrationPose, retried = false) {
  return function MigrationScene() {
    return (
      <SceneWindowFrame sidebar={null}>
        <MigrationView
          migration={MIGRATION_POSES[pose].migration}
          signIn={MIGRATION_POSES[pose].signIn}
          onSignIn={noop}
          onContinue={noop}
          onRetry={noop}
          retrying={false}
          retried={retried}
        />
      </SceneWindowFrame>
    );
  };
}

export const MigrationWaitingScene = migration("waiting");
export const MigrationImportStuckScene = migration("importStuck");
export const MigrationMovingScene = migration("moving");
export const MigrationStuckScene = migration("stuck");
export const MigrationStillStuckScene = migration("stuck", true);
export const MigrationSignInScene = migration("signIn");
export const MigrationDoneScene = migration("done");
