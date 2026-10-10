// A fresh install's first run, on the same page as the v3 migration:
// the sign-in, the terminal `sm` linked into the shell, and the first
// project, picked with the add-project dialog's own picker or from
// terrier's repos. A step already taken reads done; the app opens on
// the project once it is added.
import type { ReactNode } from "react";
import {
  SignInStepView,
  StepActionView,
  StepRepoChoicesView,
  StepRowView,
  StepsPageView,
  type StepState,
  StepStuckView,
} from "./StepsPageView.tsx";

export function OnboardingView({
  signIn,
  onSignIn,
  cli,
  onReplaceCli,
  project,
  picker,
  repos,
  addingRepo,
  onPickRepo,
}: {
  signIn: { readonly state: StepState };
  onSignIn: () => void;
  // `foreign` holds the links another program owns, which only a
  // replace asked for takes over.
  cli: { readonly state: StepState; readonly foreign: ReadonlyArray<string> };
  onReplaceCli: () => void;
  project: { readonly state: StepState };
  // The add-project dialog's picker, its own container.
  picker: ReactNode;
  // terrier's repos, when it lists any.
  repos: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  addingRepo: string | null;
  onPickRepo: (path: string) => void;
}) {
  const picking = project.state !== "done";
  return (
    <StepsPageView title="Shigoto no Mori">
      <SignInStepView
        state={signIn.state}
        asks={signIn.state !== "done"}
        onSignIn={onSignIn}
      />
      <StepRowView
        label="Command line tool"
        state={cli.state}
        trailing={
          cli.foreign.length > 0 && (
            <StepActionView label="Replace" onClick={onReplaceCli} />
          )
        }
      >
        {cli.foreign.length > 0 && (
          <StepStuckView
            items={cli.foreign.map((path) => ({
              name: path,
              reason: "points elsewhere",
            }))}
          />
        )}
      </StepRowView>
      <StepRowView label="First project" state={project.state}>
        {picking && repos.length > 0 && (
          <StepRepoChoicesView
            repos={repos}
            pending={addingRepo}
            onPick={onPickRepo}
          />
        )}
        {picking && (
          <div className="flex h-72 flex-col overflow-hidden rounded-lg border border-border bg-card">
            {picker}
          </div>
        )}
      </StepRowView>
    </StepsPageView>
  );
}
