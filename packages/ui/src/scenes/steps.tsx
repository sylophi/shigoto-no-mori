// The page a window shows in place of the app while it gets ready: the
// v3 migration in each of its states (its import under way, the
// worktrees on the move, a locked one stuck, a lapsed session's
// sign-in, every step done), and a fresh install's first run (the
// sign-in, the command line tool, the first project's pick).
import { AddExistingFormView } from "../views/addProject/AddExistingFormView.tsx";
import { MigrationView } from "../views/steps/MigrationView.tsx";
import { OnboardingView } from "../views/steps/OnboardingView.tsx";
import type { StepState } from "../views/steps/StepsPageView.tsx";
import {
  MIGRATION_POSES,
  type MigrationPose,
  TERRIER_REPOS,
} from "../fixtures/stepsFixtures.ts";
import { SceneWindowFrame } from "./frame.tsx";

const noop = () => {};

function migration(pose: MigrationPose) {
  return function MigrationScene() {
    return (
      <SceneWindowFrame sidebar={null}>
        <MigrationView
          migration={MIGRATION_POSES[pose].migration}
          signIn={MIGRATION_POSES[pose].signIn}
          onSignIn={noop}
          onContinue={noop}
        />
      </SceneWindowFrame>
    );
  };
}

export const MigrationWaitingScene = migration("waiting");
export const MigrationMovingScene = migration("moving");
export const MigrationStuckScene = migration("stuck");
export const MigrationSignInScene = migration("signIn");
export const MigrationDoneScene = migration("done");

const picker = (
  <AddExistingFormView
    query="~/dev/"
    onQuery={noop}
    onInputKeyDown={noop}
    highlighted="browse:~/dev/kawaii-cam"
    onHighlight={noop}
    browseDir="~/dev/"
    entries={[
      { name: "dotfiles", isGitRepo: true },
      { name: "kawaii-cam", isGitRepo: true },
      { name: "notes", isGitRepo: false },
      { name: "shigoto-no-mori", isGitRepo: true },
    ]}
    registeredNames={new Set()}
    isLoading={false}
    hasListing
    error={null}
    leafFilter=""
    targetIsGitRepo={false}
    canPrimary
    pending={false}
    onPrimary={noop}
    canBrowseUp
    onBrowseUp={noop}
    onBrowseTo={noop}
    onAdd={noop}
    terrierOptIn={null}
    onPickFolder={noop}
  />
);

function onboarding(
  signIn: StepState,
  cli: StepState,
  project: StepState,
  foreign: ReadonlyArray<string> = [],
) {
  return function OnboardingScene() {
    return (
      <SceneWindowFrame sidebar={null}>
        <OnboardingView
          signIn={{ state: signIn }}
          onSignIn={noop}
          cli={{ state: cli, foreign }}
          onReplaceCli={noop}
          project={{ state: project }}
          picker={picker}
          repos={TERRIER_REPOS}
          addingRepo={null}
          onPickRepo={noop}
        />
      </SceneWindowFrame>
    );
  };
}

export const OnboardingSignInScene = onboarding("waiting", "done", "waiting");
export const OnboardingCliScene = onboarding("done", "waiting", "waiting", [
  "~/.local/bin/sm",
]);
export const OnboardingProjectScene = onboarding("done", "done", "waiting");
export const OnboardingDoneScene = onboarding("done", "done", "done");
