import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useTerrierReadiness } from "@/hooks/terrier/useTerrierReadiness";
import { projectDriveBaseFor } from "@shigomori/contracts/git/worktreeLayout";
import {
  DRIVE_PROJECT_STANDIN,
  IntegrationTogglesView,
  type ToggleProps,
  WorktreeTogglesView,
} from "./DeviceSettingsSectionsView";

// The device-managed toggles (DeviceSettingsSectionsView), every query
// they need through host-scoped hooks, so the same sections answer for
// whichever device the surrounding HostScope names.
export function WorktreeToggles(props: ToggleProps) {
  // The drive folder, spelled by the layout rule itself for a stand-in
  // project, so it takes the scoped device's flavor name (".sm" for the
  // app, ".smd" for dev builds).
  const { data: runtime } = useRuntimeInfo();
  return (
    <WorktreeTogglesView
      {...props}
      driveBase={runtime && projectDriveBaseFor(DRIVE_PROJECT_STANDIN, runtime)}
    />
  );
}

export function IntegrationToggles(props: ToggleProps) {
  const { data: portPoolInstalled = true } = usePortPoolInstalled();
  const { data: terrier } = useTerrierReadiness();
  const { data: gh } = useGithubCliReadiness();
  return (
    <IntegrationTogglesView
      {...props}
      readiness={{
        portPoolInstalled,
        terrierInstalled: terrier?.installed ?? true,
        terrierReadable: terrier?.readable ?? true,
        ghInstalled: gh?.installed ?? true,
        ghAuthed: gh?.authed ?? true,
      }}
    />
  );
}
