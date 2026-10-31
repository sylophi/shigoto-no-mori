// A window whose host can't start because the import of a 2.x data dir
// is stuck (the shell parks the host, main/electron/migration.ts):
// the app mounts only once its host is up, so the window shows the
// migration's page alone, over its link to its shell. Once a Retry gets
// the import past stuck, the window boots again, its host up.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { migrationContract } from "@shigomori/contracts/modules/migration";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import { ThemeRootProvider } from "@shigomori/ui/root.tsx";
import { AppShellView } from "@shigomori/ui/views/AppShellView.tsx";
import { MigrationView } from "@shigomori/ui/views/steps/MigrationView.tsx";
import type { ClientApi } from "@/lib/runtime/Api";

const stuck = (
  progress: MigrationProgress | null,
): progress is MigrationProgress => progress?.import?.state === "stuck";

// Settles with the shell's migration once its import reads stuck: as the
// window asks, or as the shell next tells it.
export function stuckImport(api: ClientApi): Promise<MigrationProgress> {
  return new Promise((resolve) => {
    const settle = (progress: MigrationProgress | null) => {
      if (!stuck(progress)) return;
      stop();
      resolve(progress);
    };
    const stop = api.listen(api.pushes(migrationContract, "changed"), settle);
    void api.run(api.migration.read()).then(settle);
  });
}

function StuckImport({
  api,
  first,
}: {
  api: ClientApi;
  first: MigrationProgress;
}) {
  const [migration, setMigration] = useState(first);
  const [retrying, setRetrying] = useState(false);
  useEffect(
    () =>
      api.listen(api.pushes(migrationContract, "changed"), (progress) => {
        if (progress !== null && !stuck(progress)) location.reload();
        else if (progress !== null) setMigration(progress);
      }),
    [api],
  );
  return (
    <AppShellView phone={false} hasLocalHost sidebar={null}>
      <MigrationView
        migration={migration}
        signIn={null}
        onSignIn={() => {}}
        onContinue={() => {}}
        onRetry={() => {
          setRetrying(true);
          void api.run(api.migration.retry()).finally(() => setRetrying(false));
        }}
        retrying={retrying}
        retried={false}
      />
    </AppShellView>
  );
}

export function mountStuckImport(
  api: ClientApi,
  element: HTMLElement,
  first: MigrationProgress,
): void {
  createRoot(element).render(
    <StrictMode>
      <ThemeRootProvider value={element}>
        <StuckImport api={api} first={first} />
      </ThemeRootProvider>
    </StrictMode>,
  );
}
