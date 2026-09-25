import type { Dispatch, SetStateAction } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useTerrierReadiness } from "@/hooks/terrier/useTerrierReadiness";
import { ToggleRow } from "@/components/shared/ToggleRow";
import { ExternalLink } from "@/components/ui/external-link";
import { fieldSetter } from "@/hooks/ui/useDirtyForm";

const PORT_POOL = {
  href: "https://github.com/dittofleet/port-pool",
  errorTitle: "Couldn't open port-pool",
};

const TERRIER = {
  href: "https://github.com/sylophi/terrier",
  errorTitle: "Couldn't open terrier",
};

// The device-managed toggle sections, shared verbatim between this
// device's tab and every peer's tab on the Settings page. Everything
// here reads and writes only device-managed keys on SettingsFormState,
// and every query it runs (port-pool install check, gh and terrier
// readiness) goes through host-scoped hooks, so the same JSX answers
// for whichever device the surrounding HostScope names. Client-scoped
// concerns (appearance) and local-by-nature ones (the launch tools)
// live on their own tabs and must not move here.
export function DeviceToggleSections({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const { data: portPoolInstalled = true } = usePortPoolInstalled();
  const { data: terrierReadiness } = useTerrierReadiness();
  const terrierInstalled = terrierReadiness?.installed ?? true;
  const terrierCompatible = terrierReadiness?.compatible ?? true;
  const terrierReady = terrierInstalled && terrierCompatible;
  const { data: githubCliReadiness } = useGithubCliReadiness();
  const ghInstalled = githubCliReadiness?.installed ?? true;
  const ghAuthed = githubCliReadiness?.authed ?? true;
  const ghReady = ghInstalled && ghAuthed;
  const setField = fieldSetter(setForm);

  return (
    <>
      <section className="space-y-3">
        <SectionHeading className="mb-1">Worktrees</SectionHeading>
        <ToggleRow
          checked={form.deleteBranchOnRemove}
          onCheckedChange={setField("deleteBranchOnRemove")}
          label="Delete branch when removing worktree"
          description="Force-deletes the local branch the worktree had checked out. Remote branches aren't touched. Skipped when the branch is still in use elsewhere or is the repo's primary HEAD."
        />
        <ToggleRow
          checked={form.autoPullNew}
          onCheckedChange={setField("autoPullNew")}
          label="Start new worktrees with auto-pull on"
          description="Applies to worktrees you create from now on, and to the primary checkout of projects you add. Existing worktrees aren't changed, and each worktree's own auto-pull toggle still wins."
        />
        {/* A sub-option of the row above: indented past its switch so
            the nesting reads without the disabled state doing the
            talking. pl-11 is the switch width plus the row gap. */}
        <div className="pl-11">
          <ToggleRow
            checked={form.autoPullNew && form.autoPullPrimaryOnly}
            onCheckedChange={setField("autoPullPrimaryOnly")}
            disabled={!form.autoPullNew}
            label="Primary checkouts only"
            description="Only the primary checkout of a newly added project starts with auto-pull on. Other new worktrees start with it off."
          />
        </div>
        <ToggleRow
          checked={form.doubutsuNames}
          onCheckedChange={setField("doubutsuNames")}
          label="Doubutsu names"
          description="Name new worktrees after Animal Crossing villagers and characters, like raymond, instead of adjective-animal pairs like snug-otter."
        />
        {/* A sub-option of Doubutsu names, nested like Primary
            checkouts only. Unlike that row it keeps showing its stored
            value while disabled: turning names back on brings the
            villagers back as they were. What it gates reads
            useVillageLife, never this field alone. */}
        <div className="pl-11">
          <ToggleRow
            checked={form.villageLife}
            onCheckedChange={setField("villageLife")}
            disabled={!form.doubutsuNames}
            label="Village life"
            description={
              form.doubutsuNames
                ? "Your villagers come to life with a little extra flair around the app. Purely cosmetic."
                : "Turn on Doubutsu names to invite the villagers."
            }
          />
        </div>
        <ToggleRow
          checked={form.codexWorktreeNames}
          onCheckedChange={setField("codexWorktreeNames")}
          label="Name Codex-style worktrees by their parent folder"
          description="Codex and some other tools create worktrees as worktree-name/repo-name. When an external worktree's folder is just the repo's name, show the folder above it instead."
        />
      </section>

      <section className="space-y-3">
        <SectionHeading className="mb-1">Integrations</SectionHeading>
        <ToggleRow
          checked={form.githubCli && ghReady}
          onCheckedChange={setField("githubCli")}
          disabled={!ghReady}
          label="Use GitHub CLI"
          description={ghDescription(ghInstalled, ghAuthed)}
        />
        <ToggleRow
          checked={form.autoPopulateInstall}
          onCheckedChange={setField("autoPopulateInstall")}
          label="Auto-populate install command"
          description="When adding a project with a package.json, seed the setup script with the detected package manager's install command (e.g. pnpm install). Only runs at project-add time, so existing projects are untouched."
        />
        <ToggleRow
          checked={form.portPool && portPoolInstalled}
          onCheckedChange={setField("portPool")}
          disabled={!portPoolInstalled}
          label="Automatically use port-pool"
          description={
            <>
              Allocates ports for new worktrees and releases them on delete.
              Activates when a project has a{" "}
              <span className="font-mono">port-pool.config.json</span>.{" "}
              <ExternalLink {...PORT_POOL}>
                {portPoolInstalled
                  ? "Learn more"
                  : "Install port-pool to enable this integration."}
              </ExternalLink>
            </>
          }
        />
        <ToggleRow
          // Shows the persisted truth and stays operable while on:
          // when terrier vanishes or drifts out of the version
          // handshake, the CLI warns "turn the toggle off in the
          // app's Settings", so the off switch must keep working.
          // Only turning it ON requires a ready binary.
          checked={form.terrier}
          onCheckedChange={setField("terrier")}
          disabled={!terrierReady && !form.terrier}
          label="Automatically use terrier"
          description={terrierDescription(
            terrierInstalled,
            terrierCompatible,
            terrierReadiness?.version,
          )}
        />
      </section>
    </>
  );
}

function terrierDescription(
  installed: boolean,
  compatible: boolean,
  version: string | undefined,
): React.ReactNode {
  if (!installed) {
    return (
      <>
        <ExternalLink {...TERRIER}>Install terrier</ExternalLink> to enable this
        integration.
      </>
    );
  }
  if (!compatible) {
    return (
      <>
        {version ?? "The installed terrier"} isn't a version this build
        understands. Update both and try again.{" "}
        <ExternalLink {...TERRIER}>Learn more</ExternalLink>
      </>
    );
  }
  return (
    <>
      Shows every repo registered in terrier as a project. Removing one requires{" "}
      <span className="font-mono">terrier rm</span>.{" "}
      <ExternalLink {...TERRIER}>Learn more</ExternalLink>
    </>
  );
}

function ghDescription(installed: boolean, authed: boolean): React.ReactNode {
  if (!installed) {
    return (
      <>
        Install <span className="font-mono">gh</span> to enable this
        integration.
      </>
    );
  }
  if (!authed) {
    return (
      <>
        Run <span className="font-mono">gh auth login</span> to enable this
        integration.
      </>
    );
  }
  return (
    <>
      Use your authenticated <span className="font-mono">gh</span> session for
      GitHub-related actions.
    </>
  );
}
