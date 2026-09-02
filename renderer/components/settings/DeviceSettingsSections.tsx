import type { Dispatch, SetStateAction } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useTerrierReadiness } from "@/hooks/terrier/useTerrierReadiness";
import { PortPoolLink } from "./PortPoolLink";
import { TerrierLink } from "./TerrierLink";
import { ToggleRow } from "@/components/shared/ToggleRow";

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

  return (
    <>
      <section className="space-y-3">
        <SectionHeading className="mb-1">Worktrees</SectionHeading>
        <ToggleRow
          checked={form.deleteBranchOnRemove}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, deleteBranchOnRemove: v }))
          }
          label="Delete branch when removing worktree"
          description="Force-deletes the local branch the worktree had checked out. Remote branches aren't touched. Skipped when the branch is still in use elsewhere or is the repo's primary HEAD."
        />
      </section>

      <section className="space-y-3">
        <SectionHeading className="mb-1">Integrations</SectionHeading>
        <ToggleRow
          checked={form.githubCli && ghReady}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, githubCli: v }))
          }
          disabled={!ghReady}
          label="Use GitHub CLI"
          description={ghDescription(ghInstalled, ghAuthed)}
        />
        <ToggleRow
          checked={form.autoPopulateInstall}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, autoPopulateInstall: v }))
          }
          label="Auto-populate install command"
          description="When adding a project with a package.json, seed the setup script with the detected package manager's install command (e.g. pnpm install). Only runs at project-add time, so existing projects are untouched."
        />
        <ToggleRow
          checked={form.portPool && portPoolInstalled}
          onCheckedChange={(v) => setForm((prev) => ({ ...prev, portPool: v }))}
          disabled={!portPoolInstalled}
          label="Automatically use port-pool"
          description={
            <>
              Allocates ports for new worktrees and releases them on delete.
              Activates when a project has a{" "}
              <span className="font-mono">port-pool.config.json</span>.{" "}
              <PortPoolLink>
                {portPoolInstalled
                  ? "Learn more"
                  : "Install port-pool to enable this integration."}
              </PortPoolLink>
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
          onCheckedChange={(v) => setForm((prev) => ({ ...prev, terrier: v }))}
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
        <TerrierLink>Install terrier</TerrierLink> to enable this integration.
      </>
    );
  }
  if (!compatible) {
    return (
      <>
        {version ?? "The installed terrier"} isn't a version this build
        understands. Update both and try again.{" "}
        <TerrierLink>Learn more</TerrierLink>
      </>
    );
  }
  return (
    <>
      Shows every repo registered in terrier as a project. Removing one requires{" "}
      <span className="font-mono">terrier rm</span>.{" "}
      <TerrierLink>Learn more</TerrierLink>
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
