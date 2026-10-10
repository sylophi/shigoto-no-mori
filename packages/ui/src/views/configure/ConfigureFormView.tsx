// A device's project settings, drawn (ConfigureForm.tsx binds them to
// that device's project file): where the project lives, its worktrees'
// branch and location, the primary checkout, carry-over, scripts and
// the project's own tools.
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { FolderOpen, Plus } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { ErrorBanner } from "../../primitives/error-banner.tsx";
import { PathSpan } from "../../primitives/path-span.tsx";
import {
  SectionHeading,
  SectionIntro,
} from "../../primitives/section-heading.tsx";
import { fieldSetter } from "../../hooks/useDirtyForm.ts";
import { useLauncherListEditor } from "../../hooks/useLauncherListEditor.ts";
import type {
  CarryOverEntry,
  LauncherCommand,
} from "@shigomori/contracts/schemas/index";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";
import { CustomLauncherInputView } from "../shared/CustomLauncherInputView.tsx";
import { ScriptEnvPopoverView } from "../shared/ScriptEnvPopoverView.tsx";
import { PAGE_BODY } from "../shared/PageShellView.tsx";
import { ScriptFieldView } from "./ScriptFieldView.tsx";

export interface ConfigureFormState {
  defaultBranch: string;
  setup: string;
  teardown: string;
  launchers: readonly LauncherCommand[];
  carryOver: readonly CarryOverEntry[];
  useWorktreeInclude: boolean;
  showPrimaryInInbox: boolean;
}

export function ConfigureFormView({
  form,
  setForm,
  projectPath,
  home,
  remote,
  deviceLabel,
  onReveal,
  onOpenLaunchTools,
  branchPicker,
  location,
  carryOver,
  saveError,
  footer,
}: {
  form: ConfigureFormState;
  setForm: Dispatch<SetStateAction<ConfigureFormState>>;
  projectPath: string;
  home: string | null;
  // A peer's project file: revealing the folder opens THIS machine's
  // file manager, and the Settings link opens its launch tools, so
  // neither is offered, and the copy names the peer.
  remote: boolean;
  deviceLabel: string;
  onReveal: () => void;
  onOpenLaunchTools: () => void;
  // The default branch's picker (BranchCombobox).
  branchPicker: ReactNode;
  // Where its worktrees go (WorktreeLocationField).
  location: ReactNode;
  // What new worktrees carry over (CarryOverSection).
  carryOver: ReactNode;
  saveError: string | null;
  footer: ReactNode;
}) {
  const setField = fieldSetter(setForm);
  const { addLauncher, updateLauncher, removeLauncher } =
    useLauncherListEditor(setForm);

  return (
    <>
      <div className={PAGE_BODY}>
        <div className="flex flex-col gap-10">
          <section className="space-y-3">
            <SectionHeading className="mb-1">Location</SectionHeading>
            <div className="flex font-mono text-sm select-text">
              <PathSpan
                path={projectPath}
                home={home}
                className="min-w-0 flex-1 truncate"
              />
            </div>
            {!remote && (
              <Button variant="outline" size="sm" onClick={onReveal}>
                <FolderOpen />
                Reveal in Finder
              </Button>
            )}
          </section>

          <section className="space-y-4">
            <SectionIntro title="Worktrees">
              Settings for branches created inside this project.
            </SectionIntro>
            <div className="space-y-1.5">
              <label
                htmlFor="default-branch"
                className="block text-sm font-medium"
              >
                Default branch
              </label>
              {branchPicker}
              <p className="text-xs text-muted-foreground">
                Pre-fills "Branched from" when starting a new worktree. Falls
                back to <span className="font-mono">main</span> /{" "}
                <span className="font-mono">master</span> /{" "}
                <span className="font-mono">dev</span> (in that order, then the
                first local branch) when the branch you set here doesn't exist.
              </p>
            </div>
            {location}
          </section>

          <section className="space-y-3">
            <SectionHeading className="mb-1">Primary checkout</SectionHeading>
            <ToggleRowView
              checked={form.showPrimaryInInbox}
              onCheckedChange={setField("showPrimaryInInbox")}
              label="Show in the inbox"
              description="Lists it alongside the worktrees. The project view always shows it."
            />
          </section>

          {carryOver}

          <section className="space-y-4">
            <SectionIntro title="Scripts" action={<ScriptEnvPopoverView />}>
              Run inside the worktree directory.
            </SectionIntro>
            <ScriptFieldView
              id="script-setup"
              label="Setup"
              value={form.setup}
              onChange={setField("setup")}
            />
            <ScriptFieldView
              id="script-teardown"
              label="Teardown"
              value={form.teardown}
              onChange={setField("teardown")}
            />
          </section>

          <section className="space-y-3">
            {/* The Settings link opens THIS machine's launch tools, which
                say nothing about a peer's. A remote project's tools run
                from the window on that device, so say that instead. */}
            <SectionIntro
              title="Custom tools"
              action={<ScriptEnvPopoverView />}
            >
              {remote ? (
                <>
                  Tools specific to this project, launched from {deviceLabel}
                  &apos;s own window.
                </>
              ) : (
                <>
                  Tools specific to this project. For tools you want available
                  in every project (editors, agents), use{" "}
                  <button
                    type="button"
                    onClick={onOpenLaunchTools}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Settings
                  </button>
                  .
                </>
              )}
            </SectionIntro>
            {form.launchers.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                None yet. Add one to run a project-specific command in the
                worktree (e.g. <span className="font-mono">bun storybook</span>,
                a custom devbox shell).
              </p>
            ) : (
              <div className="space-y-2">
                {form.launchers.map((launcher) => (
                  <CustomLauncherInputView
                    key={launcher.id}
                    launcher={launcher}
                    onChange={(patch) => updateLauncher(launcher.id, patch)}
                    onRemove={() => removeLauncher(launcher.id)}
                  />
                ))}
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={addLauncher}>
              <Plus />
              Add project tool
            </Button>
          </section>

          {saveError !== null && (
            <ErrorBanner
              message={saveError}
              title="Couldn't save project config"
            />
          )}
        </div>
      </div>
      {footer}
    </>
  );
}
