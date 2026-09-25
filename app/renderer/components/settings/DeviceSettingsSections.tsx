import { type Dispatch, type SetStateAction, useEffect } from "react";
import { Info } from "lucide-react";
import { SectionHeading } from "@/components/ui/section-heading";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useTerrierReadiness } from "@/hooks/terrier/useTerrierReadiness";
import { useVillagerDataStatus } from "@/hooks/villagers/useVillagerData";
import { VillagerDataControl } from "./VillagerDataControl";
import { villageLifeRow } from "./villagerDataView";
import { ToggleRow } from "@/components/shared/ToggleRow";
import { ExternalLink } from "@/components/ui/external-link";
import { fieldSetter } from "@/hooks/ui/useDirtyForm";
import acNotice from "@shared/acNotice.json";

const PORT_POOL = {
  href: "https://github.com/dittofleet/port-pool",
  errorTitle: "Couldn't open port-pool",
};

const TERRIER = {
  href: "https://github.com/sylophi/terrier",
  errorTitle: "Couldn't open terrier",
};

// Shown on hover beside Doubutsu names. The name pool's entry in the
// bundled third-party licenses opens with the same text.
const AC_NOTICE = acNotice.notice;

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

  // Village life opens once there are villagers to bring along: names
  // on and the villager data downloaded, all of it. Locked, the row
  // shows the stored value, and the form holds that value, so a save
  // can't write Village life while its row is locked (an edit made
  // before the lock, like turning it on and then removing the data,
  // goes back to what the device has).
  const { data: config } = useGlobalConfig({ silentError: true });
  const { data: villagerData } = useVillagerDataStatus();
  const villageLife = villageLifeRow(form.doubutsuNames, villagerData);
  const villageLifeLocked = villageLife.locked;
  const storedVillageLife = config?.villageLife ?? false;
  useEffect(() => {
    if (config === undefined || !villageLifeLocked) return;
    setForm((prev) =>
      prev.villageLife === storedVillageLife
        ? prev
        : { ...prev, villageLife: storedVillageLife },
    );
  }, [config, villageLifeLocked, storedVillageLife, setForm]);

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
          label={
            <span className="inline-flex items-center gap-1.5">
              Doubutsu names
              {/* A button, so the icon is focusable and a click on it
                  (preventDefault) doesn't flip the row's switch. */}
              <SimpleTooltip tip={AC_NOTICE}>
                <button
                  type="button"
                  aria-label={AC_NOTICE}
                  onClick={(e) => e.preventDefault()}
                  className="inline-flex cursor-help rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <Info aria-hidden className="size-3.5" />
                </button>
              </SimpleTooltip>
            </span>
          }
          description="Name new worktrees after Animal Crossing villagers and characters, like raymond, instead of adjective-animal pairs like snug-otter."
        />
        {/* A sub-option of Doubutsu names, nested like Primary
            checkouts only, with the villager data it needs beside it.
            What it gates reads useVillageLife, never this field. */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pl-11">
          <div className="min-w-0 flex-1">
            <ToggleRow
              checked={form.villageLife}
              onCheckedChange={setField("villageLife")}
              disabled={villageLifeLocked}
              label="Village life"
              description={villageLife.description}
            />
          </div>
          <VillagerDataControl doubutsuNames={form.doubutsuNames} />
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
