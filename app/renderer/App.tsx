import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { AppErrorFallback } from "@/components/AppChrome";
import { DevThemeHotkeys } from "@/components/DevThemeHotkeys";
import { OverlaysProvider } from "@/hooks/ui/useOverlays";
import { PaletteProvider } from "@/hooks/ui/usePalette";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import type { AppRouter } from "./router";

// The provider tree around the router, one for both shells. Host
// broadcasts reach the query cache from boot, not from here: one
// watchHost per device (lib/hostWatch.ts), called by renderer/boot.tsx
// for this machine and by the remote device sync for each peer.
export function App({ router }: { router: AppRouter }) {
  return (
    <ThemeProvider>
      <PaletteProvider>
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
          <OverlaysProvider>
            <RouterProvider router={router} />
            <DevThemeHotkeys />
          </OverlaysProvider>
        </ErrorBoundary>
      </PaletteProvider>
    </ThemeProvider>
  );
}
