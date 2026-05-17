import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorFallback } from "@/components/ErrorFallback";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandPaletteProvider } from "@/hooks/useCommandPalette";
import { ThemeProvider } from "@/hooks/useTheme";
import { router } from "./router";

function AppErrorFallback({ error }: FallbackProps) {
  const err = error instanceof Error ? error : new Error(String(error));
  return (
    <ErrorFallback
      error={err}
      scope="app"
      action={{
        label: "Reload window",
        onClick: () => window.location.reload(),
      }}
    />
  );
}

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
