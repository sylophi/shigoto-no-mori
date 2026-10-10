import type { ReactNode } from "react";
import { RELEASES_PAGE_URL } from "@shared/releases";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { useReleases } from "@/hooks/system/useReleases";
import {
  ChangelogDialogView,
  type StagedUpdate,
} from "@shigomori/ui/views/settings/ChangelogDialogView.tsx";

// The app's changelog (ChangelogDialogView), read from its GitHub
// releases.
export function ChangelogDialog({
  onClose,
  ...props
}: {
  installed: string;
  staged: StagedUpdate | null;
  updatedFrom?: string;
  restartButton?: ReactNode;
  onClose: () => void;
}) {
  const releases = useReleases();
  return (
    <ModalShell
      label="Changelog"
      onClose={onClose}
      popoverClassName="max-w-2xl"
    >
      <ChangelogDialogView
        {...props}
        releases={{
          data: releases.data,
          isError: releases.isError,
          error: releases.error,
          onRetry: () => void releases.refetch(),
        }}
        releasesPageUrl={RELEASES_PAGE_URL}
        onClose={onClose}
      />
    </ModalShell>
  );
}
