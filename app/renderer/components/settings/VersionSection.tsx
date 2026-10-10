import { type ReactNode, useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useUpdater } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { ChangelogDialog } from "./ChangelogDialog";
import {
  RestartToUpdateButtonView,
  VersionSectionView,
} from "./VersionSectionView";

// A device's Version section (VersionSectionView), talking to the
// updater of the surrounding host scope: this window's own with no
// provider mounted, a peer's over its direct session inside one.
export function VersionSection({
  version,
  installed,
}: {
  version: ReactNode;
  // The same version as a string, which the changelog marks its
  // releases against: this build's tag, a peer's reported version
  // ("" before it reports one).
  installed: string;
}) {
  const { canCommand } = useCommandAccess();
  const { state, check, isError, refetch } = useUpdater();
  // Which changelog is open: what the staged update brings, or all of it.
  const [changelog, setChangelog] = useState<"news" | "all" | null>(null);
  const ready = state?.kind === "ready" ? state : null;
  return (
    <VersionSectionView
      version={version}
      canCommand={canCommand}
      state={state}
      isError={isError}
      onRetry={() => void refetch()}
      onCheck={() => check.mutate()}
      onOpenChangelog={setChangelog}
      restart={ready && <RestartToUpdateButton version={ready.version} />}
      changelog={
        changelog !== null && (
          <ChangelogDialog
            installed={installed}
            staged={changelog === "news" ? ready : null}
            restartButton={
              changelog === "news" &&
              ready && <RestartToUpdateButton version={ready.version} />
            }
            onClose={() => setChangelog(null)}
          />
        )
      }
    />
  );
}

// Restarts the scoped device into its staged update. A remote restart
// is the one action here that ends a session someone else may be
// using, so it asks for a second click where the local one has the
// busy dialog.
function RestartToUpdateButton({ version }: { version: string }) {
  const { remote } = useHostScope();
  const { canCommand } = useCommandAccess();
  const { install } = useUpdater();
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  return (
    <RestartToUpdateButtonView
      version={version}
      remote={remote}
      canCommand={canCommand}
      armed={confirm.armed}
      pending={install.isPending}
      onClick={() =>
        remote ? confirm.trigger(() => install.mutate()) : install.mutate()
      }
    />
  );
}
