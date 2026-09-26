// The two pieces the boot (renderer/boot.tsx) mounts around the app:
// the top-level error boundary's fallback and the toast host, written
// once so their look cannot drift between shells.
import type { FallbackProps } from "react-error-boundary";
import { Toaster } from "sonner";
import { ErrorFallback } from "@/components/ErrorFallback";
import { usePhoneLayout } from "@/hooks/ui/useViewport";

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
  // The tab bar owns the bottom edge on a phone, so toasts drop in
  // from the top there, below the status bar (the page draws under it:
  // viewport-fit=cover).
  const phone = usePhoneLayout();
  return (
    <Toaster
      position={phone ? "top-center" : "bottom-right"}
      offset={
        phone
          ? { top: "calc(env(safe-area-inset-top) + 12px)" }
          : { bottom: 16, right: 16 }
      }
      closeButton
      toastOptions={{
        classNames: {
          // Only the toasts sonner draws. A custom one (a villager's
          // dialogue box or letter) draws its own card.
          toast:
            "data-[styled=true]:!bg-popover data-[styled=true]:!text-popover-foreground data-[styled=true]:!border data-[styled=true]:!border-border data-[styled=true]:!shadow-md",
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
