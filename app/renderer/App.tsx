import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { AppErrorFallback } from "@/components/AppChrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DevThemeHotkeys } from "@/components/DevThemeHotkeys";
import { OverlaysProvider } from "@/hooks/ui/useOverlays";
import { DoubutsuProvider } from "@/hooks/ui/useDoubutsu";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import type { AppRouter } from "./router";

// The provider tree around the router, one for both shells. Host
// broadcasts reach the query cache from boot, not from here: one
// watchHost per device (lib/hostWatch.ts), called by renderer/boot.tsx
// for this machine and by the remote device sync for each peer.
export function App({ router }: { router: AppRouter }) {
  return (
    <ThemeProvider>
      <DoubutsuProvider>
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
          <OverlaysProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
              <DevThemeHotkeys />
            </TooltipProvider>
          </OverlaysProvider>
        </ErrorBoundary>
      </DoubutsuProvider>
    </ThemeProvider>
  );
}
