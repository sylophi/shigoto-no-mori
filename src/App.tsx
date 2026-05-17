import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppErrorFallback } from "@/components/AppErrorFallback";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandPaletteProvider } from "@/hooks/useCommandPalette";
import { ThemeProvider } from "@/hooks/useTheme";
import { router } from "./router";

export function App() {
  useEffect(
    () =>
      window.api.nav.onOpenSettings(() => {
        void router.navigate({ to: "/settings" });
      }),
    [],
  );

  return (
    <ThemeProvider>
      <ErrorBoundary FallbackComponent={AppErrorFallback}>
        <CommandPaletteProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
            <CommandPalette />
          </TooltipProvider>
        </CommandPaletteProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
