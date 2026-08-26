// The web client's boot module, the browser twin of renderer/index.tsx.
// Loaded dynamically AFTER the bridge is installed on window.api
// (web/main.tsx), because several renderer modules read window.api at
// module scope (queryKeys' device id, the remote registry's local
// facts). Keeps only the boot concerns that exist on the web: the query
// client with the shared error-toast wiring, the relay device sync, and
// the provider tree around the router.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Toaster } from "sonner";
import { DevThemeHotkeys } from "@/components/DevThemeHotkeys";
import { ErrorFallback } from "@/components/ErrorFallback";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DoubutsuProvider } from "@/hooks/ui/useDoubutsu";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import { createAppQueryClient } from "@/lib/queryClientOptions";
import { startRelayDeviceSync } from "@/lib/remote/relayDevices";
import { webRouter } from "./router";
import "@/index.css";

// The exact desktop configuration (defaults, error toasts, the
// command-refusal branch and the per-query meta opt-outs), from the one
// shared module rather than a copy that could drift.
const queryClient = createAppQueryClient();

// The registry's relay half: enrolled devices plus live presence, from
// the bridge's account and relay modules, exactly as on desktop.
startRelayDeviceSync();

function AppErrorFallback({ error }: FallbackProps) {
  const err = error instanceof Error ? error : new Error(String(error));
  return (
    <ErrorFallback
      error={err}
      scope="app"
      action={{
        label: "Reload page",
        onClick: () => window.location.reload(),
      }}
    />
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DoubutsuProvider>
          <ErrorBoundary FallbackComponent={AppErrorFallback}>
            <TooltipProvider>
              <RouterProvider router={webRouter} />
              <DevThemeHotkeys />
            </TooltipProvider>
          </ErrorBoundary>
        </DoubutsuProvider>
      </ThemeProvider>
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
    </QueryClientProvider>
  </StrictMode>,
);
