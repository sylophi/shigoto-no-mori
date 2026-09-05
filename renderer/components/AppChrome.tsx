// The two pieces the boot (renderer/boot.tsx) mounts around the app:
// the top-level error boundary's fallback and the toast host, written
// once so their look cannot drift between shells.
import type { FallbackProps } from "react-error-boundary";
import { Toaster } from "sonner";
import { ErrorFallback } from "@/components/ErrorFallback";

export function AppErrorFallback({ error }: FallbackProps) {
  const err = error instanceof Error ? error : new Error(String(error));
  return (
    <ErrorFallback
      error={err}
      scope="app"
      action={{
        label: window.api.isElectron ? "Reload window" : "Reload page",
        onClick: () => window.location.reload(),
      }}
    />
  );
}

export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      offset={{ bottom: 16, right: 16 }}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "!bg-popover !text-popover-foreground !border !border-border !shadow-md",
          title: "!select-text",
          description: "!text-muted-foreground !select-text",
          error: "!text-destructive",
          closeButton:
            "!left-auto !right-0 ![transform:translate(35%,-35%)] !bg-popover !text-muted-foreground !border-border hover:!bg-accent hover:!text-foreground",
        },
      }}
    />
  );
}
