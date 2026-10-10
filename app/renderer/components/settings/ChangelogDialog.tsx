import type { ReactNode } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { useReleases } from "@/hooks/system/useReleases";
import { ChangelogDialogView, type StagedUpdate } from "./ChangelogDialogView";

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
    <ModalShell onClose={onClose} popoverClassName="max-w-2xl">
      <ChangelogDialogView
        {...props}
        releases={{
          data: releases.data,
          isError: releases.isError,
          error: releases.error,
          onRetry: () => void releases.refetch(),
        }}
        onClose={onClose}
      />
    </ModalShell>
  );
}
