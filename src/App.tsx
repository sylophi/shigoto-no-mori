import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
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
      <CommandPaletteProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
          <CommandPalette />
        </TooltipProvider>
      </CommandPaletteProvider>
    </ThemeProvider>
  );
}
